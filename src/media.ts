import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import type { GenerationJob, StoredOutput } from "./types.js";
import { createPublicMediaUrl } from "./public-media.js";

export const mediaDir = path.resolve(process.env.MEDIA_DIR || "/opt/gemini-veo-mcp/media");
export const maxInlineBytes = Math.floor((Number(process.env.MAX_INLINE_MEDIA_MB) || 25) * 1024 * 1024);
export const maxMediaBytes = Math.floor((Number(process.env.MAX_MEDIA_MB) || 300) * 1024 * 1024);
const tombstoneRetentionDays = Number(process.env.TOMBSTONE_RETENTION_DAYS) || 30;

export async function ensureMediaDir(): Promise<void> {
  await mkdir(mediaDir, { recursive: true });
}

export async function storeBase64(generationId: string, index: number, data: string, mimeType: string): Promise<StoredOutput> {
  const buffer = Buffer.from(data, "base64");
  if (buffer.length === 0) throw new Error("Google returned an empty media payload");
  if (buffer.length > maxMediaBytes) throw new Error(`Generated media exceeds MAX_MEDIA_MB (${maxMediaBytes} bytes)`);
  const normalizedMime = normalizeMime(mimeType, buffer);
  const extension = normalizedMime === "video/mp4" ? "mp4" : normalizedMime === "image/jpeg" ? "jpg" : "png";
  const filename = `${generationId}-${index}.${extension}`;
  const outputPath = path.join(mediaDir, filename);
  await writeFile(outputPath, buffer, { mode: 0o640 });
  return metadata(outputPath, filename, normalizedMime, buffer);
}

export async function registerDownloaded(generationId: string, index: number, tempPath: string, mimeType = "video/mp4"): Promise<StoredOutput> {
  const file = await stat(tempPath);
  if (file.size === 0) throw new Error("Google returned an empty video file");
  if (file.size > maxMediaBytes) {
    await unlink(tempPath).catch(() => undefined);
    throw new Error(`Generated media exceeds MAX_MEDIA_MB (${maxMediaBytes} bytes)`);
  }
  const handle = await open(tempPath, "r");
  const header = Buffer.alloc(12);
  await handle.read(header, 0, header.length, 0);
  await handle.close();
  const normalizedMime = normalizeMime(mimeType, header);
  if (normalizedMime !== "video/mp4") throw new Error(`Expected video/mp4, received ${normalizedMime}`);
  const filename = `${generationId}-${index}.mp4`;
  const outputPath = path.join(mediaDir, filename);
  if (tempPath !== outputPath) {
    await rename(tempPath, outputPath);
  }
  await chmod(outputPath, 0o640);
  return { index, path: outputPath, filename, mimeType: normalizedMime, sizeBytes: file.size, sha256: await hashFile(outputPath) };
}

export async function outputPayload(outputs: StoredOutput[], publicBaseUrl: string, includeBase64 = true): Promise<Array<Record<string, unknown>>> {
  const totalBytes = outputs.reduce((sum, output) => sum + output.sizeBytes, 0);
  const inline = includeBase64 && totalBytes <= maxInlineBytes;
  return Promise.all(outputs.map(async (output) => {
    const signed = createPublicMediaUrl(output.filename, publicBaseUrl);
    return {
      index: output.index,
      mimeType: output.mimeType,
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
      ...signed,
      ...(inline
        ? { base64: (await readFile(output.path)).toString("base64") }
        : { downloadUrl: `${publicBaseUrl.replace(/\/$/, "")}/media/${encodeURIComponent(output.filename)}` }),
    };
  }));
}

export async function resolvePublicOutput(filename: string): Promise<StoredOutput | undefined> {
  const match = filename.match(/^([0-9a-f-]{36})-(\d+)\.(png|jpg|mp4)$/);
  if (!match) return undefined;
  const job = await loadPersistedJob(match[1]);
  const output = job?.outputs?.find((candidate) => candidate.filename === filename && candidate.index === Number(match[2]));
  if (!output || !(await outputExists(output))) return undefined;
  return output;
}

export async function removeOutputs(outputs: StoredOutput[] | undefined): Promise<void> {
  if (!outputs) return;
  await Promise.all(outputs.map((output) => unlink(output.path).catch(() => undefined)));
}

export async function persistCompletedJob(job: GenerationJob): Promise<void> {
  if (job.status !== "COMPLETED" || !job.outputs) throw new Error("Only completed jobs with outputs can be persisted");
  const manifest = {
    version: 1,
    generationId: job.generationId,
    taskTraceId: job.taskTraceId,
    kind: job.kind,
    model: job.model,
    canonicalModel: job.canonicalModel,
    estimatedCostUsd: job.estimatedCostUsd,
    status: "COMPLETED",
    createdAt: job.createdAt,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    updatedAt: job.updatedAt,
    outputs: job.outputs.map((output) => ({
      index: output.index,
      filename: output.filename,
      mimeType: output.mimeType,
      sizeBytes: output.sizeBytes,
      sha256: output.sha256,
    })),
  };
  const target = manifestPath(job.generationId);
  const temporary = `${target}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(manifest), { mode: 0o640 });
  await rename(temporary, target);
}

export async function loadPersistedJobs(): Promise<GenerationJob[]> {
  const jobs: GenerationJob[] = [];
  for (const filename of await readdir(mediaDir)) {
    const match = filename.match(/^([0-9a-f-]{36})\.manifest\.json$/);
    if (!match) continue;
    const job = await loadPersistedJob(match[1]);
    if (job) jobs.push(job);
  }
  return jobs;
}

export async function migrateLegacyOutputs(): Promise<number> {
  const groups = new Map<string, Array<{ index: number; filename: string; extension: "png" | "jpg" | "mp4" }>>();
  for (const filename of await readdir(mediaDir)) {
    const match = filename.match(/^([0-9a-f-]{36})-(\d+)\.(png|jpg|mp4)$/);
    if (!match) continue;
    const list = groups.get(match[1]) ?? [];
    list.push({ index: Number(match[2]), filename, extension: match[3] as "png" | "jpg" | "mp4" });
    groups.set(match[1], list);
  }

  let migrated = 0;
  for (const [generationId, files] of groups) {
    try {
      await stat(manifestPath(generationId));
      continue;
    } catch {
      // No manifest: this is an output created by the pre-persistence server.
    }
    if (await generationWasPurged(generationId)) continue;
    const outputs: StoredOutput[] = [];
    let latestMtime = 0;
    for (const file of files.sort((a, b) => a.index - b.index)) {
      const outputPath = path.join(mediaDir, file.filename);
      const details = await stat(outputPath);
      latestMtime = Math.max(latestMtime, details.mtimeMs);
      outputs.push({
        index: file.index,
        path: outputPath,
        filename: file.filename,
        mimeType: file.extension === "png" ? "image/png" : file.extension === "jpg" ? "image/jpeg" : "video/mp4",
        sizeBytes: details.size,
        sha256: await hashFile(outputPath),
      });
    }
    const timestamp = new Date(latestMtime || Date.now()).toISOString();
    await persistCompletedJob({
      generationId,
      kind: outputs.every((output) => output.mimeType.startsWith("image/")) ? "image" : "video",
      model: "legacy-restored",
      canonicalModel: "legacy-restored",
      arguments: {},
      estimatedCostUsd: 0,
      status: "COMPLETED",
      createdAt: timestamp,
      startedAt: timestamp,
      completedAt: timestamp,
      updatedAt: timestamp,
      outputs,
    });
    migrated += 1;
  }
  return migrated;
}

export async function loadPersistedJob(generationId: string): Promise<GenerationJob | undefined> {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(generationId), "utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || parsed.generationId !== generationId || parsed.status !== "COMPLETED") return undefined;
    if (parsed.kind !== "image" && parsed.kind !== "video") return undefined;
    if (!Array.isArray(parsed.outputs)) return undefined;
    const outputs: StoredOutput[] = parsed.outputs.map((value, position) => {
      if (!value || typeof value !== "object") throw new Error("Invalid persisted output");
      const output = value as Record<string, unknown>;
      const index = Number(output.index ?? position);
      const filename = String(output.filename ?? "");
      if (!Number.isInteger(index) || index < 0 || !safeOutputFilename(generationId, index, filename)) throw new Error("Invalid persisted output path");
      return {
        index,
        path: path.join(mediaDir, filename),
        filename,
        mimeType: String(output.mimeType),
        sizeBytes: Number(output.sizeBytes),
        sha256: String(output.sha256),
      };
    });
    return {
      generationId,
      taskTraceId: typeof parsed.taskTraceId === "string" ? parsed.taskTraceId : undefined,
      kind: parsed.kind,
      model: String(parsed.model),
      canonicalModel: String(parsed.canonicalModel),
      arguments: {},
      estimatedCostUsd: Number(parsed.estimatedCostUsd) || 0,
      status: "COMPLETED",
      createdAt: String(parsed.createdAt),
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : undefined,
      completedAt: typeof parsed.completedAt === "string" ? parsed.completedAt : undefined,
      updatedAt: String(parsed.updatedAt),
      outputs,
    };
  } catch {
    return undefined;
  }
}

export async function purgeGeneration(job: GenerationJob): Promise<void> {
  await removeOutputs(job.outputs);
  await unlink(manifestPath(job.generationId)).catch(() => undefined);
  await writeTombstone(job.generationId);
}

export async function generationWasPurged(generationId: string): Promise<boolean> {
  try {
    return (await stat(tombstonePath(generationId))).isFile();
  } catch {
    return false;
  }
}

export async function outputExists(output: StoredOutput): Promise<boolean> {
  try {
    const file = await stat(output.path);
    return file.isFile() && file.size === output.sizeBytes;
  } catch {
    return false;
  }
}

export async function cleanupOrphanMedia(retentionHours: number): Promise<number> {
  const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
  const tombstoneCutoff = Date.now() - tombstoneRetentionDays * 24 * 60 * 60 * 1000;
  let removed = 0;
  for (const filename of await readdir(mediaDir)) {
    const artifact = filename.match(/^([0-9a-f-]{36})(?:-\d+\.(?:png|jpg|mp4|download)|\.manifest\.json)$/);
    const tombstone = filename.match(/^([0-9a-f-]{36})\.expired\.json$/);
    if (!artifact && !tombstone) continue;
    const outputPath = path.join(mediaDir, filename);
    try {
      const file = await stat(outputPath);
      if (artifact && file.mtimeMs < cutoff) {
        await unlink(outputPath);
        await writeTombstone(artifact[1]);
        removed += 1;
      } else if (tombstone && file.mtimeMs < tombstoneCutoff) {
        await unlink(outputPath);
      }
    } catch {
      // A concurrent cleanup/download may have removed the file.
    }
  }
  return removed;
}

function metadata(outputPath: string, filename: string, mimeType: string, buffer: Buffer): StoredOutput {
  const index = Number(filename.match(/-(\d+)\.[^.]+$/)?.[1] ?? 0);
  return { index, path: outputPath, filename, mimeType, sizeBytes: buffer.length, sha256: createHash("sha256").update(buffer).digest("hex") };
}

async function hashFile(outputPath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(outputPath)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function normalizeMime(reported: string | undefined, data: Buffer): string {
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return "image/jpeg";
  if (data.length >= 12 && data.subarray(4, 8).toString("ascii") === "ftyp") return "video/mp4";
  return reported || "application/octet-stream";
}

function manifestPath(generationId: string): string {
  return path.join(mediaDir, `${generationId}.manifest.json`);
}

function tombstonePath(generationId: string): string {
  return path.join(mediaDir, `${generationId}.expired.json`);
}

async function writeTombstone(generationId: string): Promise<void> {
  await writeFile(tombstonePath(generationId), JSON.stringify({ generationId, purgedAt: new Date().toISOString() }), { mode: 0o640 });
}

function safeOutputFilename(generationId: string, index: number, filename: string): boolean {
  return filename.startsWith(`${generationId}-${index}.`) && /^[0-9a-f-]{36}-\d+\.(png|jpg|mp4)$/.test(filename);
}
