# justclip-mcp

**Clip any video from Claude, Cursor or any MCP client.** Video downloads run on
your machine before upload to JustClip. Same credits, same clips, same plan as the app.

## Why it's different

JustClip runs [`yt-dlp`](https://github.com/yt-dlp/yt-dlp) on your machine,
then uploads the video for processing. This avoids relying on a datacenter
connection to download YouTube videos. Source-platform restrictions still apply.

This package is the **local stdio server** for Claude Desktop, Claude Code,
Cursor, Codex and other clients that run local servers.

For Claude or ChatGPT in a browser, connect to JustClip's **hosted MCP server**:
`https://justclip.ai/api/mcp`. It uses Streamable HTTP with browser OAuth.
[Hosted setup instructions](https://justclip.ai/mcp). Hosted downloads return
links; local files must be uploaded in the dashboard. YouTube fetching is
subject to the account's plan; the local package downloads on your machine.

## Setup — no keys to copy

The first time the agent clips something, it opens your browser to
**"Authorize JustClip"**. You click **Authorize** (you're already signed in to
justclip.ai) and that's it — the token is stored locally, you never see or paste
a key. Revoke any time from **Settings**.

Use Node.js **22 or later**. For video downloads, install `yt-dlp` and `ffmpeg`:
`brew install yt-dlp ffmpeg` on macOS, or install them for your platform.
Other ways to install yt-dlp include: `brew install yt-dlp`, `pipx install yt-dlp`,
or `pip install -U yt-dlp`.

### Option A — one click (Claude Desktop)

Download the [**JustClip Desktop Extension** (`justclip.mcpb`)](https://github.com/0Xflacko/justclip-mcp/releases/latest/download/justclip.mcpb): double-click it,
Claude Desktop installs the server, and the first clip triggers the browser
Authorize. Nothing to edit.

### Option B — config (Cursor, or manual)

```json
{
  "mcpServers": {
    "justclip": {
      "command": "npx",
      "args": ["-y", "https://github.com/0Xflacko/justclip-mcp/releases/download/v0.3.0/justclip-mcp-0.3.0.tgz"]
    }
  }
}
```

The release tarball is public; an npm account is not needed.

No `env` needed — auth is the browser flow. (Power users/CI can set
`JUSTCLIP_API_KEY` to skip it, and `JUSTCLIP_BASE_URL` for staging.)

## Tools

| Tool | What it does |
|---|---|
| `account()` | Plan, credits left (and what AI can spend), biggest upload, consent status. |
| `clip_video(source, subtitleStyle?, template?, focus?, liveFrom?)` | A YouTube/Twitch/Kick URL or a local file. Videos download on your machine and upload; a live Twitch/Kick channel is clipped live. |
| `list_projects(limit?)` | Recent projects with status, length and clip count. |
| `project_status(projectId)` | Processing status and how many clips are ready. |
| `list_clips(projectId)` | Clips with hook, score, duration and render status; marks any locked by the plan's export cap. |
| `download_clip(projectId, clipId, outputPath, template?, format?)` | Save a rendered clip (.mp4) or its captions (.srt). |
| `download_all_clips(projectId, outputPath)` | Every exportable clip with covers, as one .zip. |
| `stop_live(projectId)` | Stop watching a live stream; a last pass finishes the clips. |
| `more_moments(projectId, limit?)` | Moments found but not made into clips, best first. |
| `make_clip(projectId, candidateId)` | Turn one of those moments into a finished clip (free). |
| `rename_clip(projectId, clipId, title)` | Change a clip's title. |
| `caption_variants(projectId, clipId, styleIds)` | Copies of a clip in up to 3 other caption styles (Pro, Studio). |
| `post_drafts(projectId, clipIds?)` | Ready-to-post hooks, captions and hashtags for TikTok/Shorts/Reels, X and LinkedIn. Never publishes. |
| `beat_edit(music, video? | projectId?, style?, length?, …)` | Cut footage to the beat of a song (Clipper and up). |
| `beat_edit_status(id?)` | A Beat Edit's progress, or the recent ones. |
| `download_beat_edit(id, outputPath)` | Save a finished Beat Edit. |
| `ai_models()` | AI Studio image and video models, templates, prices in credits, the account's credits. |
| `ai_ideas(clipId)` | B-roll, hook, cover and product-shot ideas for a clip, with prompts and prices. Free. |
| `ai_price(model | recipe, …)` | What a generation costs, without spending anything. |
| `ai_generate(model | recipe, clipId?, prompt?, settings?, refs?, …)` | Start an image or video generation. Spends credits; failed jobs give them back. |
| `ai_status(id)` | Queued, running, done or failed, with the wait. |
| `ai_list(clipId?)` | Generations for a clip, or the account's finished ones. |
| `ai_cancel(id)` | Cancel one that hasn't started; credits come back. |
| `ai_download(id, outputPath)` | Save a finished image or video. |
| `upload_media(path)` | Upload an image, song or short video as an AI input or cover. |
| `set_cover(clipId, generationId | key | clear)` | Set or clear a clip's cover. |

Everything spends one credit balance: clipping costs 1 credit per minute of footage, a Beat Edit 1,
and AI generation is priced per job in credits; the agent prices it with `ai_price` and asks you first. The one-time AI consent (18+, no real people or brands without consent, the
likeness consent) is yours to give in the browser; the agent can't give it for you.

## What it will NOT do

It never buys anything. When you're out of credits, hit the plan's
export cap, or have no active plan, the tool response says so in plain language
**with a link you open** — the purchase is always a human click, never the
agent's. It also can't change your plan, see your password, touch other
accounts, delete your projects or clips, publish anything, or accept terms and
consent for you.

## Example

> **You:** clip this and give me the top 3 — https://youtube.com/watch?v=…
>
> **Agent:** *(calls `clip_video` → browser opens → you click Authorize)*
> Downloaded on your machine and uploaded (own lane) — project `abc123` is
> processing. *(polls `project_status`, then `list_clips`, then `download_clip`
> for the top 3)*

## Privacy Policy

[JustClip Privacy Policy](https://justclip.ai/privacy) covers uploaded media,
account data, processing providers, storage, retention and deletion. The local
server sends the videos, media and requests you select to JustClip. AI generation
can also send selected media to the providers described in that policy after
you complete the required consent in JustClip. Local downloads contact the source
platform. This server does not send your chat history to JustClip.

Your authorization token is saved at `~/.justclip/token.json` with file mode
`0600` and reused for the same JustClip base URL. Revoke it in JustClip Settings.
Downloaded files are written to the output paths you request and may overwrite
existing files. Clipping and generation can spend your existing JustClip credits;
the server cannot buy credits or change your subscription.

Support: [justclip.ai/contact](https://justclip.ai/contact) ·
[admin@justclip.io](mailto:admin@justclip.io) ·
[Report an issue](https://github.com/0Xflacko/justclip-mcp/issues)

## Development

```sh
npm ci
npm test
npm run bundle
```

`npm run bundle` writes `artifacts/justclip.mcpb` with production dependencies.
The server source and bundle are MIT licensed; use of the JustClip service is
subject to [JustClip Terms](https://justclip.ai/terms).

## Directory listings

- [Official MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers/io.github.0Xflacko%2Fjustclip/versions/latest)
- [Smithery](https://smithery.ai/servers/denoweb3/justclip)
- [Glama local server](https://glama.ai/mcp/servers/0Xflacko/justclip-mcp)
- [Glama hosted connector](https://glama.ai/mcp/connectors/io.github.0Xflacko/justclip)

Glama's local server has passed its build and tool-discovery inspection. Its build settings are recorded in `glama-build-spec.json`; enter the startup command without the `mcp-proxy` wrapper, which Glama adds. The placeholder key is only for schema inspection. Users authorize their own JustClip account. The hosted connector separately needs a maintainer OAuth test profile and production support for Glama's callbacks.

For a Smithery release, run `npm run bundle` and `npm run smithery:metadata`. Submit `artifacts/justclip.mcpb` as the `bundle` and the JSON in `artifacts/smithery-release.json` as the `payload` using [Smithery's publish API](https://smithery.ai/docs/api-reference/servers/publish-a-server). The metadata includes actual tool input schemas required by Smithery's server card. Smithery CLI 4.11.1 copies the simpler desktop manifest entries into that card, which fails validation; the API keeps the standard MCPB manifest intact.
