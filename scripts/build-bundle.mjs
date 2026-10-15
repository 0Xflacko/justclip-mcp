import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const staging = await mkdtemp(join(tmpdir(), "justclip-mcp-bundle-"));
const output = join(root, "artifacts", "justclip.mcpb");
// npm exports its install-script allowlist into scripts, but rejects that
// inherited option during a second project install. All install scripts stay off.
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== "npm_config_allow_scripts"));
try {
  for (const file of ["dist", "manifest.json", "icon.png", "package.json", "package-lock.json", "README.md", "LICENSE"]) {
    await cp(join(root, file), join(staging, file), { recursive: true });
  }
  execFileSync("npm", ["ci", "--omit=dev", "--ignore-scripts"], { cwd: staging, stdio: "inherit", env });
  await mkdir(join(root, "artifacts"), { recursive: true });
  execFileSync("npx", ["--yes", "@anthropic-ai/mcpb@2.1.2", "pack", staging, output], { stdio: "inherit", env });
  console.log(`Bundle: ${output}`);
} finally {
  await rm(staging, { recursive: true, force: true });
}
