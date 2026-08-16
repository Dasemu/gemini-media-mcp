import { spawn } from "node:child_process";
import { mkdtemp, rm, unlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { mediaDir, registerDownloaded } from "./media.js";
import type { StoredOutput, VideoOverlay } from "./types.js";

const commandTimeoutMs = 5 * 60 * 1000;
const maxDiagnosticBytes = 256 * 1024;

interface VideoMetadata {
  durationSeconds: number;
  width: number;
  height: number;
}

export async function composeVideoOverlay(
  generationId: string,
  baseOutput: StoredOutput,
  overlays: VideoOverlay[],
): Promise<StoredOutput[]> {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "zenvairo-compose-"));
  const temporaryOutput = path.join(mediaDir, `${generationId}-0.download`);
  try {
    const metadata = await probeVideo(baseOutput.path);
    validateComposition(metadata, overlays);
    const cards: string[] = [];
    for (const [index, overlay] of overlays.entries()) {
      const outputPath = path.join(workDir, `card-${index}.png`);
      await run(process.env.PYTHON_BIN || "python3", [
        process.env.OVERLAY_CARD_SCRIPT || "/opt/gemini-veo-mcp/scripts/make_overlay_card.py",
        JSON.stringify({ text: overlay.text, kicker: overlay.kicker, style: overlay.style, out: outputPath }),
      ]);
      cards.push(outputPath);
    }

    const ffmpegArgs = buildFfmpegArguments(baseOutput.path, cards, temporaryOutput, metadata, overlays);
    await run(process.env.FFMPEG_BIN || "ffmpeg", ffmpegArgs);
    return [await registerDownloaded(generationId, 0, temporaryOutput, "video/mp4")];
  } catch (error) {
    await unlink(temporaryOutput).catch(() => undefined);
    throw error;
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

export function buildFfmpegFilter(metadata: Pick<VideoMetadata, "width" | "height">, overlays: VideoOverlay[]): string {
  const chains: string[] = ["[0:v]setpts=PTS-STARTPTS[base]"];
  overlays.forEach((overlay, index) => {
    const fade = Math.min(0.25, overlay.duration / 3);
    const fadeOutStart = overlay.duration - fade;
    chains.push(
      `[${index + 1}:v]format=rgba,scale=${metadata.width}:${metadata.height},` +
      `trim=duration=${decimal(overlay.duration)},setpts=PTS-STARTPTS,` +
      `fade=t=in:st=0:d=${decimal(fade)}:alpha=1,` +
      `fade=t=out:st=${decimal(fadeOutStart)}:d=${decimal(fade)}:alpha=1,` +
      `setpts=PTS+${decimal(overlay.start_time)}/TB[overlay${index}]`,
    );
    const input = index === 0 ? "base" : `v${index}`;
    chains.push(
      `[${input}][overlay${index}]overlay=0:0:eof_action=pass:shortest=0:format=auto[v${index + 1}]`,
    );
  });
  return chains.join(";");
}

function buildFfmpegArguments(
  basePath: string,
  cards: string[],
  outputPath: string,
  metadata: VideoMetadata,
  overlays: VideoOverlay[],
): string[] {
  const args = ["-hide_banner", "-loglevel", "error", "-y", "-i", basePath];
  for (const card of cards) args.push("-loop", "1", "-framerate", "30", "-i", card);
  args.push(
    "-filter_complex", buildFfmpegFilter(metadata, overlays),
    "-map", `[v${overlays.length}]`,
    "-map", "0:a?",
    "-map_metadata", "0",
    "-c:v", "libx264",
    "-preset", "medium",
    "-crf", "23",
    "-pix_fmt", "yuv420p",
    "-c:a", "copy",
    "-movflags", "+faststart",
    "-shortest",
    "-f", "mp4",
    outputPath,
  );
  return args;
}

async function probeVideo(inputPath: string): Promise<VideoMetadata> {
  const result = await run(process.env.FFPROBE_BIN || "ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height:format=duration",
    "-of", "json",
    inputPath,
  ]);
  let parsed: { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error("COMPOSE_INVALID_BASE_VIDEO: ffprobe returned invalid metadata");
  }
  const width = Number(parsed.streams?.[0]?.width);
  const height = Number(parsed.streams?.[0]?.height);
  const durationSeconds = Number(parsed.format?.duration);
  if (!Number.isInteger(width) || !Number.isInteger(height) || !Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new Error("COMPOSE_INVALID_BASE_VIDEO: missing duration or dimensions");
  }
  return { width, height, durationSeconds };
}

function validateComposition(metadata: VideoMetadata, overlays: VideoOverlay[]): void {
  const ratio = metadata.width / metadata.height;
  if (Math.abs(ratio - 9 / 16) > 0.02) {
    throw new Error(
      `COMPOSE_BASE_ASPECT_RATIO_UNSUPPORTED: expected a vertical 9:16 video, received ${metadata.width}x${metadata.height}`,
    );
  }
  for (const [index, overlay] of overlays.entries()) {
    if (overlay.start_time >= metadata.durationSeconds) {
      throw new Error(
        `COMPOSE_TIMING_OUT_OF_RANGE: overlays[${index}].start_time ${overlay.start_time} is outside the ${decimal(metadata.durationSeconds)}s base video`,
      );
    }
    if (overlay.start_time + overlay.duration > metadata.durationSeconds + 0.05) {
      throw new Error(
        `COMPOSE_TIMING_OUT_OF_RANGE: overlays[${index}] ends at ${decimal(overlay.start_time + overlay.duration)}s, after the ${decimal(metadata.durationSeconds)}s base video`,
      );
    }
  }
}

async function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let capturedBytes = 0;
    const capture = (target: Buffer[], chunk: Buffer) => {
      if (capturedBytes >= maxDiagnosticBytes) return;
      const remaining = maxDiagnosticBytes - capturedBytes;
      target.push(chunk.subarray(0, remaining));
      capturedBytes += Math.min(chunk.length, remaining);
    };
    child.stdout.on("data", (chunk: Buffer) => capture(stdout, chunk));
    child.stderr.on("data", (chunk: Buffer) => capture(stderr, chunk));
    const timeout = setTimeout(() => child.kill("SIGKILL"), commandTimeoutMs);
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(new Error(`COMPOSE_DEPENDENCY_ERROR: failed to start ${path.basename(command)}: ${error.message}`));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      const output = { stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") };
      if (code === 0) resolve(output);
      else reject(new Error(`COMPOSE_COMMAND_FAILED: ${path.basename(command)} exited with ${code ?? signal}: ${output.stderr.slice(-2000)}`));
    });
  });
}

function decimal(value: number): string {
  return Number(value.toFixed(3)).toString();
}
