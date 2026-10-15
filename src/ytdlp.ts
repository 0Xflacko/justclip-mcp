/**
 * Local yt-dlp — the whole point of the agent lane.
 *
 * The download runs on the USER's machine, then the file is uploaded. So it is
 * always own-lane (§1.6): zero residential-proxy cost to us, and YouTube always
 * works because the fetch comes from a real browser-class IP, not our servers.
 * If yt-dlp isn't installed we say exactly how to get it rather than failing.
 */

import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { stat } from "node:fs/promises";

export const INSTALL_HINT =
  "yt-dlp isn't installed. Install it (https://github.com/yt-dlp/yt-dlp#installation): " +
  "macOS `brew install yt-dlp`, or `pipx install yt-dlp`, or `pip install -U yt-dlp`.";

function run(cmd: string, args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

export async function hasYtDlp(): Promise<boolean> {
  try {
    const { code } = await run("yt-dlp", ["--version"]);
    return code === 0;
  } catch {
    return false;
  }
}

/**
 * Download a URL to an mp4 in the OS temp dir and return the path. Caps quality
 * at 1080p — enough for a 9:16 clip and it keeps the upload sane. The caller
 * deletes the file after upload.
 */
export async function downloadToTemp(
  url: string,
  onProgress?: (line: string) => void,
): Promise<string> {
  const out = join(tmpdir(), `justclip-${randomBytes(6).toString("hex")}.mp4`);
  const args = [
    "-f", "bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b",
    "--merge-output-format", "mp4",
    "--no-playlist",
    "--no-part",
    "-o", out,
    url,
  ];
  const child = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stdout.on("data", (d) => onProgress?.(d.toString().trim()));
  child.stderr.on("data", (d) => (stderr += d.toString()));
  const code: number = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  if (code !== 0) {
    throw new Error(`yt-dlp failed (exit ${code}). ${stderr.split("\n").filter(Boolean).slice(-2).join(" ")}`);
  }
  // Confirm the file landed (yt-dlp respects our exact -o path with merge).
  await stat(out);
  return out;
}
