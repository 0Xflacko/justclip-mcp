/**
 * Browser sign-in for the agent (PKCE + loopback). No key to copy.
 *
 * First run: opens the browser to /oauth/authorize, the user clicks "Authorize",
 * we receive the code on a temporary 127.0.0.1 port, exchange it (with the PKCE
 * verifier) for a token, and cache it at ~/.justclip/token.json. After that the
 * token is reused silently. Set JUSTCLIP_API_KEY to skip the browser (CI/power
 * users). Everything still runs locally — that's what keeps YouTube own-lane.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { readFile, writeFile, mkdir, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE_URL = (process.env.JUSTCLIP_BASE_URL ?? "https://justclip.ai").replace(/\/$/, "");
const TOKEN_DIR = join(homedir(), ".justclip");
const TOKEN_FILE = join(TOKEN_DIR, "token.json");
const AUTH_TIMEOUT_MS = 5 * 60 * 1000;

let cached: string | null = null;

/** The token to use, running the browser flow once if we don't have one yet. */
export async function ensureToken(): Promise<string> {
  if (process.env.JUSTCLIP_API_KEY) return process.env.JUSTCLIP_API_KEY;
  if (cached) return cached;
  const stored = await readStored();
  if (stored) return (cached = stored);
  const tok = await authorize();
  cached = tok;
  await writeStored(tok);
  return tok;
}

/** Forget the token (e.g. after a 401 — it was revoked). Next call re-auths. */
export async function clearToken(): Promise<void> {
  cached = null;
  await rm(TOKEN_FILE, { force: true }).catch(() => {});
}

async function readStored(): Promise<string | null> {
  try {
    const j = JSON.parse(await readFile(TOKEN_FILE, "utf8")) as { access_token?: string; base_url?: string };
    return j.base_url === BASE_URL && j.access_token ? j.access_token : null;
  } catch {
    return null;
  }
}

async function writeStored(token: string): Promise<void> {
  try {
    await mkdir(TOKEN_DIR, { recursive: true });
    await writeFile(TOKEN_FILE, JSON.stringify({ access_token: token, base_url: BASE_URL }), { mode: 0o600 });
  } catch {
    /* if we can't persist, we just re-auth next run */
  }
}

function openBrowser(url: string): void {
  const p = process.platform;
  const [cmd, args] = p === "darwin" ? ["open", [url]] : p === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* fall back to the printed URL below */
  }
}

async function authorize(): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const state = randomBytes(16).toString("hex");

  return new Promise<string>((resolve, reject) => {
    let redirectUri = "";
    const timer = setTimeout(() => {
      server.close();
      reject(new Error("Timed out waiting for browser authorization."));
    }, AUTH_TIMEOUT_MS);

    const server = createServer((req, res) => {
      const u = new URL(req.url ?? "/", "http://127.0.0.1");
      if (u.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<html><body style='font-family:system-ui;text-align:center;margin-top:80px'>" +
          "<h2>JustClip is connected.</h2><p>You can close this tab and return to your editor.</p></body></html>",
      );
      clearTimeout(timer);
      server.close();

      const err = u.searchParams.get("error");
      const code = u.searchParams.get("code");
      if (err) return reject(new Error(`Authorization denied (${err}).`));
      if (!code || u.searchParams.get("state") !== state) {
        return reject(new Error("Authorization failed (state mismatch)."));
      }
      // Exchange the code for a token — the verifier proves this is the same
      // client that started the flow.
      fetch(`${BASE_URL}/api/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ grant_type: "authorization_code", code, code_verifier: verifier, redirect_uri: redirectUri }),
      })
        .then(async (r) => {
          const data = (await r.json().catch(() => null)) as { access_token?: string } | null;
          if (!r.ok || !data?.access_token) throw new Error("Token exchange failed.");
          resolve(data.access_token);
        })
        .catch(reject);
    });

    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      redirectUri = `http://127.0.0.1:${port}/callback`;
      const authUrl = new URL(`${BASE_URL}/oauth/authorize`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");
      authUrl.searchParams.set("client_name", process.env.JUSTCLIP_CLIENT_NAME ?? "Agent");
      // stderr, never stdout (stdout is the MCP channel).
      console.error(`\nAuthorize JustClip in your browser:\n${authUrl.toString()}\n`);
      openBrowser(authUrl.toString());
    });
  });
}

export { BASE_URL };
