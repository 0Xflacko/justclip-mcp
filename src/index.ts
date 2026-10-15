#!/usr/bin/env node
/**
 * justclip-mcp — the JustClip agent lane (Money Model Spec P1-7).
 *
 * A stdio MCP server that lets Claude, Cursor or any MCP client use JustClip:
 * clip videos and live streams, find more moments, caption variants, post
 * drafts, Beat Edits, and the AI Studio (image and video models). Downloads
 * run on the USER's machine (yt-dlp), then the file is uploaded — so it is
 * always own-lane (§1.6): YouTube always works, nothing is installed in the
 * browser, and there is no residential-proxy cost to us. Upsells (out of
 * credits, locked clips) come back inside the tool responses
 * as text + links; the agent never buys anything, never deletes anything, and
 * never accepts terms or consent for the user.
 *
 * Config (env, set in the MCP client's server config):
 *   JUSTCLIP_API_KEY   optional — a key from https://justclip.ai/settings
 *                      (without it, the first call opens the browser to authorize)
 *   JUSTCLIP_BASE_URL  optional — defaults to https://justclip.ai
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { access, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  apiGet,
  apiPatch,
  apiPost,
  uploadFile,
  downloadClip,
  downloadTo,
  relayUpload,
  fmtCredits,
  JustClipError,
  BASE_URL,
} from "./client.js";
import { hasYtDlp, downloadToTemp, INSTALL_HINT } from "./ytdlp.js";

const server = new McpServer({ name: "justclip-mcp", version: "0.3.0" });

/** A text tool result. */
function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}
/** A tool result flagged as an error (the client shows it as a failure). */
function err(s: string) {
  return { content: [{ type: "text" as const, text: s }], isError: true };
}
/** Run a tool body; a JustClip refusal arrives already phrased for a human. */
async function run(body: () => Promise<ReturnType<typeof text>>) {
  try {
    return await body();
  } catch (e) {
    if (e instanceof JustClipError) return err(e.message);
    return err(e instanceof Error ? e.message : String(e));
  }
}

async function isLocalFile(p: string): Promise<boolean> {
  try {
    await access(p);
    return !/^https?:\/\//i.test(p);
  } catch {
    return false;
  }
}

function classifyUrl(url: string): "youtube" | "twitch" | "kick" | "other" {
  if (/(?:youtube\.com|youtu\.be)/i.test(url)) return "youtube";
  if (/twitch\.tv/i.test(url)) return "twitch";
  if (/kick\.com/i.test(url)) return "kick";
  return "other";
}

/**
 * A Twitch/Kick channel page (twitch.tv/name, kick.com/name) is the live
 * stream — the server records it in windows. Downloading it here would never
 * end. VODs (/videos/…, /v/…, /video/…) and clips are files.
 */
function isChannelUrl(url: string): boolean {
  try {
    const u = new URL(url);
    if (/^clips\.twitch\.tv$/i.test(u.hostname) || u.searchParams.has("clip")) return false;
    return u.pathname.split("/").filter(Boolean).length === 1;
  } catch {
    return false;
  }
}

const fmtTime = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
const json = (v: unknown) => JSON.stringify(v);

const CAPTION_STYLES = [
  "tiktok",
  "podcast",
  "bold-keyword",
  "stream-reaction",
  "lyric",
  "cinematic",
  "apple",
  "editorial",
  "clean",
  "hormozi",
  "clean-explainer",
  "quiet-luxury",
  "one-word",
] as const;
const FOCUS = ["funny", "conflict", "emotional", "reveals", "hype", "advice"] as const;

// ═══ Account ══════════════════════════════════════════════════════════════

server.registerTool(
  "account",
  {
    title: "Account",
    description: "Show the JustClip account this key belongs to: plan, credits left this cycle, the biggest upload, how many credits AI can spend, and whether the owner has done the one-time AI consent.",
    inputSchema: {},
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async () =>
    run(async () => {
      const me = await apiGet("/api/user/me");
      const gen = await apiGet("/api/gen/me").catch(() => null);
      const left = (me.sourceMinutes ?? 0) + (me.bonusMinutes ?? 0);
      const plan = me.plan && me.plan !== "free" ? me.plan : "no active plan";
      const lines = [
        `Plan: ${plan}`,
        `Credits left this cycle: ${left.toLocaleString("en-US")} (plan grants ${(me.planMinutes ?? 0).toLocaleString("en-US")})`,
        typeof me.maxUploadBytes === "number" ? `Biggest upload: ${Math.round(me.maxUploadBytes / 1e9)} GB` : "",
      ];
      if (gen?.credits) {
        const resets = gen.credits.resetsAt ? `, plan credits reset ${String(gen.credits.resetsAt).slice(0, 10)}` : "";
        const trial = gen.credits.trial ? "; during the free trial only bought credits work on AI" : "";
        lines.push(`AI can spend: ${fmtCredits(gen.credits.total)} (plan ${gen.credits.plan}, bought ${gen.credits.bought}${resets}${trial})`);
        if (!gen.attested || !gen.consented) {
          lines.push(
            `AI consent: not done yet. Before the first AI generation the owner accepts it once in the browser (${BASE_URL}/edit, any AI generation). I can't accept it for them.`,
          );
        }
      } else {
        lines.push("AI Studio: not available on this account.");
      }
      lines.push(
        me.plan === "free" || !me.plan
          ? `No credits to spend yet. Start the 3-day Clipper trial or pick a plan: ${BASE_URL}/settings`
          : `Manage billing: ${BASE_URL}/settings`,
      );
      return text(lines.filter(Boolean).join("\n"));
    }),
);

// ═══ Clipping ═════════════════════════════════════════════════════════════

server.registerTool(
  "clip_video",
  {
    title: "Clip Video",
    description: "Turn a video or a live stream into short clips. Give a YouTube/Twitch/Kick URL or a local file path. " +
      "Videos are downloaded on THIS machine (own lane — YouTube always works), then uploaded. A Twitch/Kick " +
      "channel URL (twitch.tv/name, kick.com/name) that is live is clipped live by JustClip while it streams; " +
      "stop it with stop_live. Costs 1 credit per minute of the video's length. Returns the project id to poll with project_status.",
    inputSchema: {
      source: z.string().describe("A YouTube/Twitch/Kick URL, or an absolute path to a local video file."),
      subtitleStyle: z.string().optional().describe(`Caption style id (default 'tiktok'): ${CAPTION_STYLES.join(", ")}.`),
      template: z.enum(["blurred", "clean"]).optional().describe("Pad style for 9:16 (default 'blurred')."),
      focus: z.array(z.enum(FOCUS)).optional().describe("Optional: what kind of moments to hunt for."),
      liveFrom: z
        .enum(["start", "now"])
        .optional()
        .describe("Live Twitch streams only: clip from the start of the stream or from now. Ask the user; leave out the first time."),
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
  },
  async ({ source, subtitleStyle, template, focus, liveFrom }) =>
    run(async () => {
      const uploadOpts = { subtitleStyle, selectedTemplate: template, focusTargets: focus };
      const started = (id: string, how: string) =>
        text(`${how} — project ${id} is processing. Poll with project_status("${id}").`);

      // 1) A local file — just upload it.
      if (await isLocalFile(source)) {
        const { id } = await uploadFile(source, uploadOpts);
        return started(id, "Uploaded your file");
      }
      if (!/^https?:\/\//i.test(source)) return err(`"${source}" isn't a URL or an existing file path.`);

      const kind = classifyUrl(source);
      const yt = await hasYtDlp();
      const viaServer = async (k: "twitch" | "kick") => {
        const { id } = await apiPost("/api/projects", {
          youtubeUrl: source,
          sourceType: k,
          subtitleStyle,
          selectedTemplate: template,
          ...(focus?.length ? { focusTargets: focus } : {}),
          ...(liveFrom ? { liveFrom } : { askLiveFrom: true }),
        });
        return id as string;
      };

      // 2) YouTube MUST be fetched locally (own lane) — we don't server-fetch it.
      if (kind === "youtube") {
        if (!yt) {
          return err(
            `${INSTALL_HINT}\nYouTube has to be downloaded on your machine (that's what keeps it working and free). ` +
              `Or paste a Twitch/Kick link, or a local file.`,
          );
        }
        const file = await downloadToTemp(source);
        try {
          const { id } = await uploadFile(file, uploadOpts);
          return started(id, "Downloaded on your machine and uploaded (own lane)");
        } finally {
          await rm(file, { force: true }).catch(() => {});
        }
      }

      if (kind === "twitch" || kind === "kick") {
        // 3) A channel (a live stream): JustClip records it.
        if (isChannelUrl(source)) {
          const id = await viaServer(kind);
          return started(id, `Watching the ${kind} stream live — clips arrive while it streams; stop with stop_live("${id}")`);
        }
        // 4) A VOD or clip: download here if yt-dlp is installed (saves our
        //    bandwidth, still own lane); otherwise hand the URL to the server.
        if (yt) {
          const file = await downloadToTemp(source);
          try {
            const { id } = await uploadFile(file, uploadOpts);
            return started(id, "Downloaded on your machine and uploaded");
          } finally {
            await rm(file, { force: true }).catch(() => {});
          }
        }
        return started(await viaServer(kind), `Sent the ${kind} link to JustClip`);
      }

      return err("Only YouTube, Twitch and Kick URLs (or local files) are supported.");
    }),
);

server.registerTool(
  "list_projects",
  {
    title: "List Projects",
    description: "List the account's recent projects (newest first) with status, length and clip count.",
    inputSchema: { limit: z.number().int().min(1).max(50).optional().describe("How many (default 20).") },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ limit }) =>
    run(async () => {
      const r = await apiGet(`/api/projects?limit=${limit ?? 20}`);
      const rows = (r.projects ?? []).map(
        (p: {
          id: string;
          title: string | null;
          sourceType: string;
          status: string;
          progress: number;
          duration: number | null;
          clipCount: number;
          isLive: boolean;
          liveStatus: string | null;
          createdAt: string;
        }) =>
          `• ${p.id}  ${p.status}${p.status !== "done" && p.status !== "error" ? ` ${p.progress}%` : ""}  ` +
          `${p.sourceType}${p.isLive ? ` (live: ${p.liveStatus ?? "?"})` : ""}  ` +
          `${p.duration ? fmtTime(p.duration) : "-"}  ${p.clipCount} clips  ${String(p.createdAt).slice(0, 10)}  ${p.title ?? ""}`,
      );
      return text(rows.length ? `${rows.join("\n")}\n(${r.total} projects in all)` : "No projects yet.");
    }),
);

server.registerTool(
  "project_status",
  {
    title: "Project Status",
    description: "Check a project's processing status and how many clips are ready.",
    inputSchema: { projectId: z.string() },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId }) =>
    run(async () => {
      const p = await apiGet(`/api/projects/${projectId}`);
      const clips: Array<{ status: string }> = p.clips ?? [];
      const ready = clips.filter((c) => c.status === "done").length;
      const live = p.isLive && p.liveStatus === "is_live";
      const lines = [
        `Status: ${p.status}${typeof p.progress === "number" ? ` (${p.progress}%)` : ""}`,
        p.progressMessage ? `— ${p.progressMessage}` : "",
        `Clips: ${ready} ready of ${clips.length}`,
        live ? `The stream is still being watched live. Stop with stop_live("${projectId}").` : "",
        p.status === "done" || ready > 0 ? `List them with list_clips("${projectId}").` : "",
      ].filter(Boolean);
      return text(lines.join("\n"));
    }),
);

server.registerTool(
  "list_clips",
  {
    title: "List Clips",
    description: "List a project's clips with their hook, score, duration and render status. Marks any clips locked by the plan's export cap.",
    inputSchema: { projectId: z.string() },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId }) =>
    run(async () => {
      const p = await apiGet(`/api/projects/${projectId}`);
      const clips: Array<{ id: string; title: string; hook?: string | null; viralScore: number; duration: number; status: string }> = (
        p.clips ?? []
      )
        .slice()
        .sort((a: { viralScore: number }, b: { viralScore: number }) => b.viralScore - a.viralScore);
      const cap: number | null = p.exportGate?.cap ?? null;
      const exportableCount: number = p.exportGate?.exportableCount ?? clips.length;
      if (clips.length === 0) return text("No clips yet — the project may still be processing.");

      const rows = clips.map((c, i) => {
        const locked = cap !== null && i >= exportableCount;
        const head = (c.hook ?? "").trim() || c.title;
        const state = c.status === "done" ? "" : `  (${c.status})`;
        return `${locked ? "🔒" : "•"} ${c.id}  [${c.viralScore}]  ${fmtTime(c.duration)}  ${head}${state}${locked ? "  (locked)" : ""}`;
      });
      const footer =
        cap !== null && clips.length > exportableCount
          ? `\n${clips.length} found, your plan exports ${exportableCount}. Unlock all with Clipper: ${BASE_URL}/pricing`
          : "";
      return text(
        `${rows.join("\n")}${footer}\n\nDownload one with download_clip, all with download_all_clips; more_moments lists moments that weren't made into clips.`,
      );
    }),
);

server.registerTool(
  "download_clip",
  {
    title: "Download Clip",
    description: "Download a rendered clip (or its captions as .srt) to a local path. Fails with an unlock message if the clip is locked by the plan's export cap.",
    inputSchema: {
      projectId: z.string(),
      clipId: z.string(),
      outputPath: z.string().describe("Absolute path to write to (.mp4, or .srt with format 'srt')."),
      template: z.enum(["blurred", "clean"]).optional(),
      format: z.enum(["video", "srt"]).optional().describe("'video' (default) or 'srt' captions."),
    },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId, clipId, outputPath, template, format }) =>
    run(async () => {
      const { bytes } = await downloadClip(projectId, clipId, outputPath, template ?? "blurred", format ?? "video");
      return text(`Saved to ${outputPath} (${(bytes / 1e6).toFixed(1)} MB).`);
    }),
);

server.registerTool(
  "download_all_clips",
  {
    title: "Download All Clips",
    description: "Download every ready clip of a project the plan can export, with covers, as one .zip.",
    inputSchema: { projectId: z.string(), outputPath: z.string().describe("Absolute path for the .zip.") },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId, outputPath }) =>
    run(async () => {
      const { bytes } = await downloadTo(`/api/projects/${projectId}/export`, outputPath);
      return text(`Saved the zip to ${outputPath} (${(bytes / 1e6).toFixed(1)} MB).`);
    }),
);

server.registerTool(
  "stop_live",
  {
    title: "Stop Live",
    description: "Stop watching a live stream. JustClip runs one last pass over what it recorded, then the project finishes.",
    inputSchema: { projectId: z.string() },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId }) =>
    run(async () => {
      const r = await apiPost(`/api/projects/${projectId}/live/stop`, {});
      return text(r.alreadyStopped ? "It was already stopped." : `Stopped. Final clips follow — poll project_status("${projectId}").`);
    }),
);

server.registerTool(
  "more_moments",
  {
    title: "More Moments",
    description: "List the moments JustClip found in a project but did not make into clips, best first. Turn one into a clip with make_clip (free).",
    inputSchema: { projectId: z.string(), limit: z.number().int().min(1).max(100).optional().describe("How many (default 20).") },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId, limit }) =>
    run(async () => {
      const r = await apiGet(`/api/projects/${projectId}/candidates?limit=${limit ?? 20}`);
      const rows = (r.candidates ?? []).map(
        (c: { id: string; start: number; end: number; duration: number; scoreLabel: string; score: number; pickable: boolean; textSnippet: string | null }) =>
          `${c.pickable ? "•" : "·"} ${c.id}  ${fmtTime(c.start)}–${fmtTime(c.end)} (${Math.round(c.duration)}s)  ${c.scoreLabel} ${Math.round(c.score)}  ` +
          `"${(c.textSnippet ?? "").replace(/\s+/g, " ").slice(0, 90)}"`,
      );
      return text(rows.length ? `${rows.join("\n")}\n\nMake one into a clip with make_clip(projectId, candidateId).` : "No other moments left in this project.");
    }),
);

server.registerTool(
  "make_clip",
  {
    title: "Make Clip",
    description: "Turn a moment from more_moments into a finished clip (hook, captions, render). Free; the clip renders in the background.",
    inputSchema: { projectId: z.string(), candidateId: z.string() },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
  },
  async ({ projectId, candidateId }) =>
    run(async () => {
      try {
        const r = await apiPost(`/api/projects/${projectId}/candidates/${candidateId}/materialize`, {});
        return text(`Clip ${r.clipId} is rendering. It shows up in list_clips("${projectId}") when ready.`);
      } catch (e) {
        if (e instanceof JustClipError && e.code === "already_materialized") {
          return text(`That moment is already clip ${String(e.data?.clipId ?? "")}.`);
        }
        throw e;
      }
    }),
);

server.registerTool(
  "rename_clip",
  {
    title: "Rename Clip",
    description: "Change a clip's title.",
    inputSchema: { projectId: z.string(), clipId: z.string(), title: z.string().min(1).max(120) },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId, clipId, title }) =>
    run(async () => {
      const r = await apiPatch(`/api/projects/${projectId}/clips/${clipId}`, { title });
      return text(`Renamed to "${r.title}".`);
    }),
);

server.registerTool(
  "caption_variants",
  {
    title: "Caption Variants",
    description: "Render copies of a clip in up to 3 other caption styles (Pro and Studio plans; at most 3 per clip). Each copy is a new clip id.",
    inputSchema: {
      projectId: z.string(),
      clipId: z.string(),
      styleIds: z.array(z.enum(CAPTION_STYLES)).min(1).max(3),
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
  },
  async ({ projectId, clipId, styleIds }) =>
    run(async () => {
      const r = await apiPost(`/api/projects/${projectId}/clips/${clipId}/variants`, { styleIds });
      return text(`Rendering ${r.clipIds.length} variant(s): ${r.clipIds.join(", ")}. They appear in list_clips when ready.`);
    }),
);

server.registerTool(
  "post_drafts",
  {
    title: "Post Drafts",
    description: "Ready-to-post text for a project's clips: hook line, caption and hashtags for TikTok/Shorts/Reels, X and LinkedIn drafts, file names. Nothing is published.",
    inputSchema: {
      projectId: z.string(),
      clipIds: z.array(z.string()).optional().describe("Only these clips (default: all ready clips)."),
    },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ projectId, clipIds }) =>
    run(async () => {
      const q = clipIds?.length ? `?clipIds=${encodeURIComponent(clipIds.join(","))}` : "";
      const r = await apiGet(`/api/projects/${projectId}/pack${q}`);
      const rows = (r.rows ?? []).map((row: Record<string, unknown>) => ({
        id: row.id,
        file: row.filename,
        length: row.lengthLabel,
        hook: row.hookLine,
        drafts: row.drafts,
      }));
      return text(rows.length ? JSON.stringify(rows, null, 1) : "No ready clips to write for yet.");
    }),
);

// ═══ Beat Edit ════════════════════════════════════════════════════════════

server.registerTool(
  "beat_edit",
  {
    title: "Beat Edit",
    description: "Cut a video to the beat of a song (Beat Edit; Clipper plan and up). Give the song as a local file, and the footage as a local " +
      "video file OR an existing projectId. Costs 1 credit. Returns the edit id for beat_edit_status.",
    inputSchema: {
      music: z.string().describe("Absolute path to the song (mp3/wav/m4a/aac/ogg/flac, or a music video)."),
      video: z.string().optional().describe("Absolute path to the footage (mp4/mov/webm/mkv, 2 s to 30 min, up to 1 GB)."),
      projectId: z.string().optional().describe("Use this project's video instead of a file."),
      style: z.enum(["trailer", "velocity", "performance", "lyric"]).optional().describe("Default 'velocity'."),
      length: z.union([z.literal(15), z.literal(30), z.literal(45), z.literal(60)]).optional().describe("Seconds."),
      fill: z.enum(["blur", "crop"]).optional().describe("How a wide video fills 9:16."),
      captions: z.boolean().optional(),
      captionStyle: z.enum(["lyric", "tiktok", "clean", "hormozi", "apple"]).optional(),
      musicStart: z.number().min(0).max(3600).optional().describe("Where in the song to start, in seconds."),
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
  },
  async ({ music, video, projectId, style, length, fill, captions, captionStyle, musicStart }) =>
    run(async () => {
      if (!video === !projectId) return err("Give exactly one of video (a file) or projectId.");
      if (!(await isLocalFile(music))) return err(`"${music}" isn't an existing file.`);
      if (video && !(await isLocalFile(video))) return err(`"${video}" isn't an existing file.`);
      const song = await relayUpload(music, "beat-music");
      const clip = video ? await relayUpload(video, "beat-video") : null;
      const r = await apiPost("/api/beat-edits", {
        musicKey: song.key,
        musicName: song.name,
        ...(clip ? { videoKey: clip.key, videoName: clip.name } : { projectId }),
        ...(style ? { style } : {}),
        ...(length ? { length } : {}),
        ...(fill ? { fill } : {}),
        ...(captions !== undefined ? { captions } : {}),
        ...(captionStyle ? { captionStyle } : {}),
        ...(musicStart !== undefined ? { musicStart } : {}),
      });
      return text(`Beat Edit ${r.id} is being made (charged ${fmtCredits(r.chargedMinutes)}). Check with beat_edit_status("${r.id}").`);
    }),
);

server.registerTool(
  "beat_edit_status",
  {
    title: "Beat Edit Status",
    description: "Check a Beat Edit's progress; with no id, list the recent ones.",
    inputSchema: { id: z.string().optional() },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ id }) =>
    run(async () => {
      type Edit = { id: string; status: string; progress: number; message: string | null; error: string | null; style: string; length: number; createdAt: string };
      const line = (e: Edit) =>
        `${e.id}  ${e.status}${e.status !== "done" && e.status !== "failed" ? ` ${e.progress}%` : ""}  ${e.style} ${e.length}s  ${String(e.createdAt).slice(0, 10)}` +
        `${e.error ? `  — ${e.error}` : e.message ? `  — ${e.message}` : ""}`;
      if (id) {
        const e = (await apiGet(`/api/beat-edits/${id}`)) as Edit;
        return text(`${line(e)}${e.status === "done" ? `\nDownload with download_beat_edit("${id}", outputPath).` : ""}`);
      }
      const r = await apiGet("/api/beat-edits?limit=20");
      return text((r.edits ?? []).map(line).join("\n") || "No Beat Edits yet.");
    }),
);

server.registerTool(
  "download_beat_edit",
  {
    title: "Download Beat Edit",
    description: "Download a finished Beat Edit to a local .mp4.",
    inputSchema: { id: z.string(), outputPath: z.string().describe("Absolute path for the .mp4.") },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ id, outputPath }) =>
    run(async () => {
      const { bytes } = await downloadTo(`/api/beat-edits/${id}/download?dl=1`, outputPath);
      return text(`Saved to ${outputPath} (${(bytes / 1e6).toFixed(1)} MB).`);
    }),
);

// ═══ AI Studio (image and video models) ═══════════════════════════════════

const REF = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("media"), key: z.string().describe("A key from upload_media."), role: z.string().optional() }),
  z.object({ kind: z.literal("clipFrame"), t: z.number().describe("Seconds into the CLIP (its edit)."), role: z.string().optional() }),
  z.object({ kind: z.literal("clipSpan"), start: z.number(), end: z.number(), role: z.string().optional() }),
  z.object({
    kind: z.literal("generation"),
    id: z.string().describe("An earlier generation's id."),
    media: z.enum(["image", "video"]).optional(),
    role: z.string().optional(),
  }),
]);

const OTHER_RECIPES = `Other recipes (send as recipe + params; frameAt/span are SOURCE-video seconds; ImageRef = {key} | {generationId} | {frameAt}):
  broll.drafts {prompt} — 4 stills · broll.shot {image, prompt, seconds 3-5} — animate a still
  cover.drafts {image, headline, prompt?} — 4 covers · cover.hd {draftId, image, headline}
  product.drafts {product, person?, presetId?, prompt?, productAuthorized:true} · product.hd {…, draftId}
  hook.payoff {image, prompt} · hook.reveal {first, last, prompt} · hook.cinematic {image, prompt, resolution}
  canvas.loop {image, prompt} (no clip) · art.extend {image, prompt?} (no clip)
  restyle.kling {span:{start,end}, prompt, images[], ownFootage:true} · genjutsu.motion/.swap {span, images[], prompt?, resolution?, ownFootage:true}`;

let catalogCache: { models: Array<{ id: string; recipe: string }> } | null = null;
async function recipeForModel(model: string): Promise<string> {
  catalogCache ??= await apiGet("/api/gen/catalog");
  const m = catalogCache!.models.find((x) => x.id === model);
  if (!m) throw new JustClipError(400, `Unknown model "${model}". See ai_models.`);
  return m.recipe;
}

/** The body /api/gen/quote and /api/gen/requests take, from the tool's input. */
async function genBody(a: {
  model?: string;
  recipe?: string;
  clipId?: string;
  prompt?: string;
  settings?: Record<string, string | number | boolean>;
  refs?: z.infer<typeof REF>[];
  templateId?: string;
  ownFootage?: boolean;
  productAuthorized?: boolean;
  params?: Record<string, unknown>;
}): Promise<{ recipe: string; clipId?: string; params: Record<string, unknown> }> {
  if (a.model) {
    return {
      recipe: await recipeForModel(a.model),
      ...(a.clipId ? { clipId: a.clipId } : {}),
      params: {
        model: a.model,
        prompt: (a.prompt ?? "").trim(),
        settings: a.settings ?? {},
        refs: a.refs ?? [],
        ...(a.templateId ? { templateId: a.templateId } : {}),
        ...(a.ownFootage ? { ownFootage: true } : {}),
        ...(a.productAuthorized ? { productAuthorized: true } : {}),
      },
    };
  }
  if (!a.recipe) throw new JustClipError(400, "Give a model (from ai_models) or a recipe with params.");
  return {
    recipe: a.recipe,
    ...(a.clipId ? { clipId: a.clipId } : {}),
    params: {
      ...(a.params ?? {}),
      ...(a.ownFootage ? { ownFootage: true } : {}),
      ...(a.productAuthorized ? { productAuthorized: true } : {}),
    },
  };
}

const GEN_INPUT = {
  model: z.string().optional().describe("A studio model id from ai_models (e.g. 'gpt-image-2.5-flare', 'kling-3.0-turbo', 'seedance-2.5-t2v')."),
  recipe: z.string().optional().describe("Instead of model: another recipe id (see ai_models), with params."),
  clipId: z.string().optional().describe("The clip it is for. Needed by every recipe except canvas.loop and art.extend; frames/spans come from it."),
  prompt: z.string().optional(),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional().describe("Model settings from ai_models (duration, resolution, aspect_ratio, count…)."),
  refs: z.array(REF).max(20).optional().describe("Inputs: uploaded media, a frame or a span of the clip, or an earlier generation. role from ai_models (e.g. 'start', 'end', 'product')."),
  templateId: z.string().optional().describe("A template id from ai_models, when using its preset."),
  params: z.record(z.string(), z.unknown()).optional().describe("For a recipe (not a model): its params, see ai_models."),
  ownFootage: z
    .boolean()
    .optional()
    .describe("The user's statement that the footage is theirs or they have the rights. Required for edits of real footage. Set ONLY if the user said so."),
  productAuthorized: z
    .boolean()
    .optional()
    .describe("The user's statement that they may promote this product/brand. Required for product shots. Set ONLY if the user said so."),
};

server.registerTool(
  "ai_models",
  {
    title: "AI Models",
    description: "The AI Studio: every image and video model with its inputs, settings and price in credits, the ready templates, the credits AI can spend, and whether the one-time consent is done. Call this before ai_generate.",
    inputSchema: {},
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async () =>
    run(async () => {
      const [me, cat] = await Promise.all([apiGet("/api/gen/me"), apiGet("/api/gen/catalog")]);
      catalogCache = cat;
      type Setting = { type: string; options?: (string | number)[]; min?: number; max?: number; default: string | number };
      const models = (cat.models ?? []).map(
        (m: {
          id: string;
          label: string;
          output: string;
          recipe: string;
          blurb: string;
          refs: { min: number; max: number; kinds: string[]; roles?: string[] };
          settings: Record<string, Setting>;
          price: { unit: string; from: number };
          source?: { minSeconds: number; maxSeconds: number };
          prompt: { required: boolean; max: number };
        }) => {
          const settings = Object.entries(m.settings)
            .map(([k, s]) => `${k}=${s.default}${s.options ? ` [${s.options.join("|")}]` : s.min !== undefined ? ` [${s.min}-${s.max}]` : ""}`)
            .join(", ");
          const refs = m.refs.max
            ? `refs ${m.refs.min}-${m.refs.max} ${m.refs.kinds.join("/")}${m.refs.roles?.length ? ` roles ${m.refs.roles.join("/")}` : ""}`
            : "no refs";
          const src = m.source ? `, source ${m.source.minSeconds}-${m.source.maxSeconds}s` : "";
          return `• ${m.id} (${m.output}) — ${m.label}: ${m.blurb}\n    ${refs}${src}; prompt ${m.prompt.required ? "required" : "optional"} ≤${m.prompt.max}; from ${fmtCredits(m.price.from)}/${m.price.unit}\n    settings: ${settings || "none"}`;
        },
      );
      const templates = (cat.templates ?? []).map(
        (t: { id: string; label: string; model: string; fromCredits: number; needsClipFrame?: boolean; needsClipSpan?: boolean; promptScaffold: string }) =>
          `• ${t.id} — ${t.label}: model ${t.model}, from ${fmtCredits(t.fromCredits)}${t.needsClipFrame ? ", needs a clip frame" : ""}${t.needsClipSpan ? ", needs a clip span" : ""}. Prompt idea: ${t.promptScaffold}`,
      );
      const consent =
        me.attested && me.consented
          ? "Consent: done."
          : `Consent: NOT done — the owner accepts it once in the browser before the first generation (${BASE_URL}/edit). I can't accept it for them.`;
      return text(
        [
          `AI can spend: ${fmtCredits(me.credits?.total ?? 0)}${me.credits?.trial ? " (during the free trial only bought credits work on AI)" : ""}. ${consent}`,
          "",
          "Models (ai_generate with model + prompt + settings + refs):",
          ...models,
          "",
          "Templates (ai_generate with templateId + its model):",
          ...templates,
          "",
          OTHER_RECIPES,
          "",
          "Always ai_price first and tell the user the cost before ai_generate.",
        ].join("\n"),
      );
    }),
);

server.registerTool(
  "ai_ideas",
  {
    title: "AI Ideas",
    description: "AI ideas for a clip: B-roll moments, a hook opener, a cover and product shots, each with prompts, timing and price. Free.",
    inputSchema: { clipId: z.string() },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ clipId }) =>
    run(async () => {
      const r = await apiGet(`/api/gen/extras?clipId=${encodeURIComponent(clipId)}`);
      const steps = (s: Array<{ recipe: string; credits: number; optional?: boolean }>) =>
        s.map((x) => `${x.recipe} ${x.credits} credits${x.optional ? " (optional)" : ""}`).join(" → ");
      const out: string[] = [];
      for (const b of r.broll ?? []) {
        out.push(`B-roll ${fmtTime(b.start)}–${fmtTime(b.end)}: ${b.idea} (${b.why})\n  still: ${b.stillPrompt}\n  motion: ${b.motionPrompt}\n  steps: ${steps(b.steps)}; request ${json(b.request)}`);
      }
      if (r.hook) {
        out.push(`Hook (${r.hook.template}): ${r.hook.idea} (${r.hook.why})\n  still: ${r.hook.stillPrompt}\n  motion: ${r.hook.motionPrompt}\n  steps: ${steps(r.hook.steps)}; request ${json(r.hook.request)}`);
      }
      if (r.cover) {
        out.push(`Cover "${r.cover.headline}" (${r.cover.style}): ${r.cover.stylePrompt} (${r.cover.why})\n  steps: ${steps(r.cover.steps)}; request ${json(r.cover.request)}`);
      }
      for (const p of r.product ?? []) {
        out.push(`Product "${p.name}" ${fmtTime(p.start)}–${fmtTime(p.end)}: ${p.idea}\n  prompt: ${p.prompt}\n  steps: ${steps(p.steps)}; request ${json(p.request)}`);
      }
      return text(out.length ? out.join("\n\n") : "No ideas for this clip.");
    }),
);

server.registerTool(
  "ai_price",
  {
    title: "AI Price",
    description: "Price an AI generation in credits without spending anything. Same inputs as ai_generate.",
    inputSchema: GEN_INPUT,
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async (a) =>
    run(async () => {
      const body = await genBody(a);
      const r = await apiPost("/api/gen/quote", body);
      return text(`${fmtCredits(r.credits)}. Pass expectedCredits: ${r.credits} to ai_generate.`);
    }),
);

server.registerTool(
  "ai_generate",
  {
    title: "AI Generate",
    description: "Start an AI image or video generation. SPENDS credits: price it with ai_price and get the user's OK first. " +
      "Returns generation ids; follow them with ai_status, save with ai_download. Jobs the AI provider fails, blocks or cancels give their credits back.",
    inputSchema: {
      ...GEN_INPUT,
      expectedCredits: z.number().int().optional().describe("The price from ai_price; refused (not charged) if the price changed."),
    },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
  },
  async (a) =>
    run(async () => {
      const body = await genBody(a);
      const r = await apiPost("/api/gen/requests", {
        ...body,
        requestKey: randomUUID(),
        ...(a.expectedCredits !== undefined ? { expectedCredits: a.expectedCredits } : {}),
      });
      return text(
        `Started ${r.ids.length} generation(s): ${r.ids.join(", ")}. Charged ${fmtCredits(r.charged)}; ${r.credits?.total ?? "?"} left for AI.\n` +
          `Follow with ai_status(id); save with ai_download(id, outputPath).`,
      );
    }),
);

type GenView = {
  id: string;
  kind: string;
  status: string;
  prompt: string;
  outputKey: string | null;
  error: string | null;
  recipe: string;
  model?: string;
  credits: number;
  createdAt: string;
  late?: boolean;
};
const genLine = (g: GenView) =>
  `${g.id}  ${g.status}${g.late ? " (late)" : ""}  ${g.model ?? g.recipe} (${g.kind})  ${String(g.createdAt).slice(0, 16)}  "${(g.prompt ?? "").slice(0, 70)}"` +
  `${g.error ? `  — ${g.error}` : ""}`;

server.registerTool(
  "ai_status",
  {
    title: "AI Status",
    description: "Check an AI generation: queued, running, done, failed, nsfw or canceled, with the wait estimate.",
    inputSchema: { id: z.string() },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ id }) =>
    run(async () => {
      const g = (await apiGet(`/api/gen/${id}`)) as GenView & { etaMs?: number; queuePosition?: number | null };
      const wait =
        g.status === "queued" || g.status === "running"
          ? `\nAbout ${Math.max(1, Math.round((g.etaMs ?? 0) / 1000))} s${g.queuePosition ? `, place ${g.queuePosition} in the queue` : ""}.`
          : "";
      const next = g.status === "done" ? `\nSave it with ai_download("${id}", outputPath).` : "";
      return text(`${genLine(g)}${wait}${next}`);
    }),
);

server.registerTool(
  "ai_list",
  {
    title: "AI List",
    description: "List AI generations: those made for one clip (any status), or the account's finished ones.",
    inputSchema: { clipId: z.string().optional() },
    annotations: {"readOnlyHint":true,"destructiveHint":false,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ clipId }) =>
    run(async () => {
      const r = await apiGet(`/api/gen/library${clipId ? `?clipId=${encodeURIComponent(clipId)}` : ""}`);
      return text((r.items ?? []).map(genLine).join("\n") || "No generations yet.");
    }),
);

server.registerTool(
  "ai_cancel",
  {
    title: "AI Cancel",
    description: "Cancel an AI generation that hasn't started at the provider yet; its credits come back.",
    inputSchema: { id: z.string() },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ id }) =>
    run(async () => {
      await apiPost(`/api/gen/${id}/cancel`, {});
      return text("Canceled; the credits are back on the balance.");
    }),
);

server.registerTool(
  "ai_download",
  {
    title: "AI Download",
    description: "Save a finished AI generation (image or video) to a local file.",
    inputSchema: { id: z.string(), outputPath: z.string().describe("Absolute path; use the right extension (.png/.jpg/.webp or .mp4).") },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ id, outputPath }) =>
    run(async () => {
      const g = (await apiGet(`/api/gen/${id}`)) as GenView;
      if (g.status !== "done" || !g.outputKey) return err(`It isn't ready (status: ${g.status}).`);
      const { bytes } = await downloadTo(`/api/media/${g.outputKey}`, outputPath);
      const ext = g.outputKey.split(".").pop();
      return text(`Saved to ${outputPath} (${(bytes / 1e6).toFixed(1)} MB, the file is .${ext}).`);
    }),
);

server.registerTool(
  "upload_media",
  {
    title: "Upload Media",
    description: "Upload a local image, song or short video to the account's media, for AI inputs (refs kind 'media') or a clip cover. Returns its key.",
    inputSchema: { path: z.string().describe("Absolute path: png/jpg/webp ≤20 MB, mp3/wav/m4a ≤50 MB, mp4/mov/webm ≤200 MB.") },
    annotations: {"readOnlyHint":false,"destructiveHint":false,"idempotentHint":false,"openWorldHint":true},
  },
  async ({ path }) =>
    run(async () => {
      if (!(await isLocalFile(path))) return err(`"${path}" isn't an existing file.`);
      const r = await relayUpload(path, "media");
      return text(`Uploaded. key: ${r.key}`);
    }),
);

server.registerTool(
  "set_cover",
  {
    title: "Set Cover",
    description: "Set a clip's cover (thumbnail): a finished cover generation, an uploaded image key, or clear it.",
    inputSchema: {
      clipId: z.string(),
      generationId: z.string().optional().describe("A finished cover.drafts / cover.hd generation."),
      key: z.string().optional().describe("An image key from upload_media."),
      clear: z.boolean().optional(),
    },
    annotations: {"readOnlyHint":false,"destructiveHint":true,"idempotentHint":true,"openWorldHint":true},
  },
  async ({ clipId, generationId, key, clear }) =>
    run(async () => {
      if ([generationId, key, clear ? "x" : undefined].filter(Boolean).length !== 1) {
        return err("Give exactly one of generationId, key or clear: true.");
      }
      const body = clear ? { generationId: null } : generationId ? { generationId } : { key };
      await apiPost(`/api/clips/${clipId}/cover`, body);
      return text(clear ? "Cover cleared." : "Cover set.");
    }),
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Never write to stdout — it's the MCP channel. Logs go to stderr.
  console.error(`justclip-mcp running against ${BASE_URL}`);
}

main().catch((e) => {
  console.error("justclip-mcp failed to start:", e);
  process.exit(1);
});
