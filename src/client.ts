/**
 * Thin JustClip API client for the MCP server.
 *
 * Auth is a token obtained via the browser flow (auth.ts) — no key to copy.
 * Its one bit of intelligence is turning the money-model 402s into plain
 * sentences the agent can relay (out of credits, YouTube gate, locked clips), and
 * re-authorizing once if the token was revoked. The MCP never buys anything —
 * every upsell is a link the human opens.
 */

import { createWriteStream, openAsBlob } from "node:fs";
import { basename } from "node:path";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ensureToken, clearToken, BASE_URL } from "./auth.js";

export class JustClipError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly code?: string,
    readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "JustClipError";
  }
}

async function authHeader(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await ensureToken()}` };
}

/** "1 credit", "1,250 credits": as the app shows a balance or a price (1 credit = 1 minute of video). */
export function fmtCredits(n: number): string {
  const c = Math.max(0, Math.round(n));
  return `${c.toLocaleString("en-US")} ${c === 1 ? "credit" : "credits"}`;
}

/** Turn a money-model 402 into a message the agent reads out, with links. */
function upsellMessage(code: string | undefined, data: Record<string, unknown>): string | null {
  const pack = `${BASE_URL}/pricing#add-on`;
  const plans = `${BASE_URL}/pricing`;
  const settings = `${BASE_URL}/settings`;
  switch (code) {
    case "insufficient_hours": {
      // 1 credit = 1 minute of footage, so the *Minutes fields are credits.
      const need = typeof data.neededMinutes === "number" ? fmtCredits(data.neededMinutes) : null;
      const have = typeof data.remainingMinutes === "number" ? fmtCredits(data.remainingMinutes) : null;
      // The server carries the pack price in the customer's own currency — the
      // package can't import pricing.ts, so it must never guess "$12". A server
      // from before the one credit balance sends packHours, not packCredits.
      const packSize =
        typeof data.packCredits === "number"
          ? fmtCredits(data.packCredits)
          : typeof data.packHours === "number"
            ? `${data.packHours} hours`
            : null;
      const packPrice = typeof data.packPrice === "string" ? data.packPrice : null;
      const addPack =
        packSize != null && packPrice != null
          ? `Add ${packSize} for ${packPrice}: ${pack}`
          : `Add credits: ${pack}`;
      return `Not enough credits${need != null ? `: this needs ${need}` : ""}${have != null ? `, you have ${have} left` : ""}. ${addPack}, or move up a plan: ${plans}. (I can't buy it; open the link.)`;
    }
    case "youtube_gate": {
      // The server names the plan with more YouTube fetching (Pro, Studio),
      // priced in the customer's own currency, when there is one.
      const upgrade =
        typeof data.upgradeName === "string"
          ? `, or ${data.upgradeName}${typeof data.upgradePrice === "string" ? ` (${data.upgradePrice}/mo)` : ""}, which fetches YouTube for you each month`
          : "";
      return `That YouTube link needs to be fetched on your machine (which I do), the helper or an upload${upgrade}. See ${plans}.`;
    }
    case "clip_locked":
      return `That clip is above your plan's export limit (${data.exportableCount ?? "?"} of ${data.total ?? "?"} exportable). Unlock all with Clipper: ${plans}.`;
    case "plan_required":
      return `This account has no active plan. Start the 3-day Clipper trial or pick a plan: ${settings}.`;
    case "plan_upgrade":
    case "variants_plan":
      return `${typeof data.error === "string" ? data.error : "Your plan doesn't include this."} See ${plans}.`;
    case "no_credits":
      // The server's sentence says why (during the trial only bought credits work on AI).
      return `${typeof data.error === "string" ? data.error : "Not enough credits for that."} Add credits: ${settings}#ai-credits (I can't buy them; open the link).`;
    default:
      return null;
  }
}

/** Refusals that need the human, not the agent: said plainly, with where to go. */
function humanStepMessage(status: number, code: string | undefined, data: Record<string, unknown>): string | null {
  if (status === 428 && (code === "attest" || code === "consent")) {
    // Statements only the account owner can make. The server refuses them
    // from an API key, and the agent must never make them for the user.
    const what =
      code === "attest"
        ? "confirm once that they are 18+ and won't use real people or brands without consent"
        : "give the one-time likeness consent (real footage or photos go to the AI provider)";
    return `Before the first AI generation the account owner has to ${what}. Open ${BASE_URL}/edit in the browser, start any AI generation there and accept the sheet that appears, then try again. I can't accept it for you.`;
  }
  if (status === 409 && code === "price_changed") {
    return `The price changed to ${typeof data.credits === "number" ? fmtCredits(data.credits) : "? credits"}. Ask again with that price if the user agrees.`;
  }
  if (status === 409 && code === "live_from_choice") {
    const s = typeof data.liveForSeconds === "number" ? data.liveForSeconds : 0;
    const live = `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
    return `This stream has been live for ${live}. Ask the user: clip it from the start (as far back as Twitch keeps) or from now on? Then call clip_video again with liveFrom "start" or "now".`;
  }
  if (status === 429) {
    const why = typeof data.error === "string" ? data.error : "Too many requests right now.";
    return `${why} (a limit was reached; try again later)`;
  }
  return null;
}

async function parse(res: Response): Promise<unknown> {
  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  if (res.ok) return body;

  const data = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  const code = typeof data.code === "string" ? data.code : undefined;
  const friendly = (res.status === 402 ? upsellMessage(code, data) : null) ?? humanStepMessage(res.status, code, data);
  const message = friendly ?? (typeof data.error === "string" ? data.error : `Request failed (${res.status})`);
  throw new JustClipError(res.status, message, code, data);
}

/**
 * A request that re-authorizes once on a 401 (the token was revoked from
 * Settings). Every call goes through here so that recovery is automatic.
 */
async function request(method: "GET" | "POST" | "PATCH", path: string, init: RequestInit = {}, retry = true): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    method,
    headers: { ...(await authHeader()), Accept: "application/json", ...(init.headers ?? {}) },
  });
  if (res.status === 401 && retry) {
    await clearToken();
    return request(method, path, init, false); // ensureToken() will re-run the browser flow
  }
  return parse(res);
}

export function apiGet(path: string): Promise<any> {
  return request("GET", path);
}

export function apiPost(path: string, json: unknown): Promise<any> {
  return request("POST", path, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  });
}

export function apiPatch(path: string, json: unknown): Promise<any> {
  return request("PATCH", path, {
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(json),
  });
}

/**
 * Save what a GET returns to a file, streamed (a project zip can be large).
 * JustClip answers some downloads with a redirect to a short-lived storage
 * link: that hop is followed WITHOUT our Authorization header. The link
 * carries its own signature, and storage refuses a request with two.
 */
export async function downloadTo(path: string, outPath: string, retry = true): Promise<{ bytes: number }> {
  let res = await fetch(`${BASE_URL}${path}`, { headers: await authHeader(), redirect: "manual" });
  if (res.status === 401 && retry) {
    await clearToken();
    return downloadTo(path, outPath, false);
  }
  for (let hops = 0; res.status >= 300 && res.status < 400 && hops < 3; hops++) {
    const to = res.headers.get("location");
    if (!to) break;
    res = await fetch(new URL(to, BASE_URL), { redirect: "manual" });
  }
  if (!res.ok || !res.body) await parse(res); // throws the friendly message (incl. clip_locked)
  let bytes = 0;
  const body = Readable.fromWeb(res.body as import("node:stream/web").ReadableStream);
  body.on("data", (c: Buffer) => (bytes += c.length));
  try {
    await pipeline(body, createWriteStream(outPath));
  } catch (e) {
    await rm(outPath, { force: true }).catch(() => {});
    throw e;
  }
  return { bytes };
}

const MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  m4a: "audio/mp4",
  aac: "audio/aac",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

/**
 * Upload a small file (an image, a song, a Beat Edit video) the way the app
 * does: one PUT straight to storage with a link from /api/uploads/media-start,
 * then /media-complete checks it and answers with the file's key.
 * purpose "media" gives { key } for AI references and covers; "beat-video" /
 * "beat-music" give { key, kind, duration, name, bytes } for a Beat Edit.
 */
export async function relayUpload(
  filePath: string,
  purpose: "media" | "beat-video" | "beat-music",
): Promise<{ key: string; duration?: number; name?: string }> {
  const blob = await openAsBlob(filePath);
  const name = basename(filePath);
  const ext = (name.split(".").pop() || "").toLowerCase();
  const contentType = MEDIA_TYPES[ext] ?? TYPES[ext] ?? "";
  const { ticket, putUrl } = (await apiPost("/api/uploads/media-start", { purpose, fileName: name, size: blob.size, contentType })) as {
    ticket: string;
    putUrl: string;
  };
  // No Authorization header: the link carries its own signature.
  const put = await fetch(putUrl, { method: "PUT", body: blob });
  if (!put.ok) throw new JustClipError(put.status, `The upload to storage failed (HTTP ${put.status}). Try again.`);
  return apiPost("/api/uploads/media-complete", { ticket });
}

const TYPES: Record<string, string> = {
  mp4: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  mkv: "video/x-matroska",
  mp3: "audio/mpeg",
  wav: "audio/wav",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Upload a local file. It goes straight to JustClip's storage (R2) in parts —
 * four at a time, each retried on its own — so a multi-GB VOD neither passes
 * through the web server (capped at 100 MB a request behind Cloudflare) nor
 * restarts from zero when one request drops. The project is created by
 * /api/uploads/complete, with the same length check and credit charge as any
 * upload. openAsBlob streams from disk; nothing is held in memory.
 *
 * Servers without direct upload (503) get the classic multipart /api/upload.
 */
export async function uploadFile(
  filePath: string,
  opts: { subtitleStyle?: string; selectedTemplate?: string; focusTargets?: string[] } = {},
): Promise<{ id: string }> {
  const blob = await openAsBlob(filePath);
  const name = basename(filePath);
  const ext = (name.split(".").pop() || "").toLowerCase();

  let started: { ticket: string; partSize: number; partCount: number };
  try {
    started = await apiPost("/api/uploads/start", { fileName: name, size: blob.size, contentType: TYPES[ext] ?? "" });
  } catch (err) {
    if (err instanceof JustClipError && err.status === 503) return classicUpload(blob, name, opts);
    throw err;
  }
  const { ticket, partSize, partCount } = started;

  const etags = new Map<number, string>();
  let next = 1;
  const putPart = async (n: number) => {
    const piece = blob.slice((n - 1) * partSize, Math.min(blob.size, n * partSize));
    for (let attempt = 1; ; attempt++) {
      try {
        // A fresh link every attempt: one that expired or failed is not reused.
        const { urls } = (await apiPost("/api/uploads/parts", { ticket, partNumbers: [n] })) as { urls: Record<string, string> };
        // No Authorization header here: the link carries its own signature.
        const res = await fetch(urls[String(n)], { method: "PUT", body: piece });
        const etag = res.headers.get("etag");
        if (!res.ok || !etag) throw new Error(`part ${n}: HTTP ${res.status}`);
        etags.set(n, etag);
        return;
      } catch (err) {
        if (attempt >= 5) throw err;
        await sleep(1000 * 2 ** (attempt - 1));
      }
    }
  };
  try {
    await Promise.all(
      Array.from({ length: Math.min(4, partCount) }, async () => {
        while (next <= partCount) await putPart(next++);
      }),
    );
  } catch (err) {
    await apiPost("/api/uploads/abort", { ticket }).catch(() => {});
    throw new JustClipError(400, `The upload kept failing (${(err as Error).message}). Check the connection and try again.`);
  }

  return apiPost("/api/uploads/complete", {
    ticket,
    parts: [...etags.entries()].map(([PartNumber, ETag]) => ({ PartNumber, ETag })),
    ...(opts.subtitleStyle ? { subtitleStyle: opts.subtitleStyle } : {}),
    ...(opts.selectedTemplate ? { selectedTemplate: opts.selectedTemplate } : {}),
    ...(opts.focusTargets?.length ? { focusTargets: opts.focusTargets } : {}),
  }) as Promise<{ id: string }>;
}

/** The classic multipart upload, for servers without direct upload. */
function classicUpload(
  blob: Blob,
  name: string,
  opts: { subtitleStyle?: string; selectedTemplate?: string },
): Promise<{ id: string }> {
  const form = new FormData();
  form.append("file", blob, name);
  if (opts.subtitleStyle) form.append("subtitleStyle", opts.subtitleStyle);
  if (opts.selectedTemplate) form.append("selectedTemplate", opts.selectedTemplate);
  return request("POST", "/api/upload", { body: form }) as Promise<{ id: string }>;
}

export async function downloadClip(
  projectId: string,
  clipId: string,
  outPath: string,
  template: "blurred" | "clean" = "blurred",
  format: "video" | "srt" = "video",
): Promise<{ bytes: number }> {
  return downloadTo(`/api/projects/${projectId}/clips/${clipId}/download?template=${template}&format=${format}`, outPath);
}

export { BASE_URL };
