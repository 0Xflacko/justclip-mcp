import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const client = new Client({ name: "justclip-directory-metadata", version: "1.0.0" });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("dist/index.js", root))],
  env: { ...process.env, JUSTCLIP_API_KEY: "metadata-discovery-only" },
  stderr: "pipe",
});

try {
  await client.connect(transport);
  // Discovery is local and does not call JustClip or authorize an account.
  const { tools } = await client.listTools();
  const release = {
    type: "stdio",
    runtime: "node",
    serverCard: {
      serverInfo: { name: manifest.name, version: manifest.version },
      tools,
    },
  };
  await mkdir(new URL("artifacts/", root), { recursive: true });
  await writeFile(new URL("artifacts/smithery-release.json", root), JSON.stringify(release, null, 2) + "\n");
  console.log(`Smithery release metadata: ${tools.length} tools with full input schemas.`);
} finally {
  await client.close();
}
