import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("packaged stdio server discovers all tools and calls the API without browser login", async () => {
  const requests = [];
  const api = createServer((req, res) => {
    requests.push({ path: req.url, authorization: req.headers.authorization });
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/api/user/me") {
      res.end(JSON.stringify({ plan: "clipper", sourceMinutes: 120, bonusMinutes: 5, planMinutes: 180 }));
    } else if (req.url === "/api/gen/me") {
      res.end(JSON.stringify({ credits: { total: 125, plan: 120, bought: 5 }, attested: true, consented: true }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "Project not found" }));
    }
  });
  await new Promise((resolve) => api.listen(0, "127.0.0.1", resolve));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [process.env.JUSTCLIP_TEST_ENTRY || fileURLToPath(new URL("../dist/index.js", import.meta.url))],
    env: { ...process.env, JUSTCLIP_BASE_URL: `http://127.0.0.1:${api.address().port}`, JUSTCLIP_API_KEY: "smoke-test-key" },
    stderr: "pipe",
  });
  const client = new Client({ name: "justclip-publication-smoke", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const manifest = JSON.parse(await readFile(new URL("../manifest.json", import.meta.url), "utf8"));
    assert.deepEqual(tools.map((t) => t.name).sort(), manifest.tools.map((t) => t.name).sort());
    for (const tool of tools) {
      assert.ok(tool.title, `${tool.name} needs a title`);
      assert.equal(typeof tool.annotations?.readOnlyHint, "boolean");
      assert.equal(typeof tool.annotations?.destructiveHint, "boolean");
    }
    const account = await client.callTool({ name: "account", arguments: {} });
    assert.ok(!account.isError);
    assert.match(account.content[0].text, /Plan: clipper/);
    assert.match(account.content[0].text, /125/);
    const missing = await client.callTool({ name: "project_status", arguments: { projectId: "missing" } });
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /Project not found/);
    assert.ok(requests.length >= 3);
    assert.ok(requests.every((r) => r.authorization === "Bearer smoke-test-key"));
    console.log(`${tools.length} tools discovered; account and API error paths passed.`);
  } finally {
    await client.close();
    await new Promise((resolve) => api.close(resolve));
  }
});
