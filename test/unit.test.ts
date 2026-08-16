import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import test, { after } from "node:test";
import { normalizeArguments } from "../src/arguments.js";
import { estimateCost, resolveModel } from "../src/catalog.js";
import { JobManager } from "../src/jobs.js";
import { ensureMediaDir, loadPersistedJob, mediaDir, outputPayload, persistCompletedJob, purgeGeneration, storeBase64 } from "../src/media.js";
import { isTransient } from "../src/retry.js";
import type { GenerationJob } from "../src/types.js";

await ensureMediaDir();
after(async () => { await rm(mediaDir, { recursive: true, force: true }); });

test("resolves public aliases and estimates current Veo pricing", () => {
  const model = resolveModel("veo-3.1-fast", "video");
  const args = normalizeArguments(model, [
    { name: "prompt", value: "A short vertical brand film" },
    { name: "resolution", value: "1080p" },
    { name: "duration_seconds", value: 8 },
  ]);
  assert.equal(model.canonicalApiModel, "veo-3.1-fast-generate-preview");
  assert.equal(estimateCost(model, args), 0.96);
});

test("rejects unsupported Veo combinations and audio=false", () => {
  const model = resolveModel("veo-3.1-lite", "video");
  assert.throws(() => normalizeArguments(model, [{ name: "prompt", value: "x" }, { name: "resolution", value: "1080p" }, { name: "duration_seconds", value: 4 }]), /requires duration_seconds=8/);
  assert.throws(() => normalizeArguments(model, [{ name: "prompt", value: "x" }, { name: "with_audio", value: false }]), /Invalid 'with_audio'.*Allowed: true/);
});

test("only transient provider errors are retryable", () => {
  assert.equal(isTransient({ status: 429 }), true);
  assert.equal(isTransient({ status: 503 }), true);
  assert.equal(isTransient({ status: 400 }), false);
});

test("accepts a valid inline reference image and rejects mismatched MIME", () => {
  const model = resolveModel("nano-banana-2", "image");
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
  const args = normalizeArguments(model, [
    { name: "prompt", value: "Continue this visual style" },
    { name: "reference_images", value: [{ base64: png, mime_type: "image/png" }] },
  ]);
  assert.equal((args.reference_images as unknown[]).length, 1);
  assert.throws(() => normalizeArguments(model, [
    { name: "prompt", value: "Continue this visual style" },
    { name: "reference_images", value: [{ base64: png, mime_type: "image/jpeg" }] },
  ]), /content does not match image\/jpeg/);
});

test("resolves a generation_id reference and a mixed reference array", async () => {
  const manager = managerWithJobs();
  const source = await completedImageJob();
  injectJob(manager, source);
  const inline = tinyPng();
  const resolved = await manager.resolveImageReferences({ reference_images: [
    { generation_id: source.generationId, index: 0 },
    { base64: inline, mime_type: "image/png" },
  ] });
  const references = resolved.reference_images as Array<Record<string, unknown>>;
  assert.equal(references.length, 2);
  assert.equal(references[0].mime_type, "image/png");
  assert.equal(references[0].base64, inline);
  assert.equal(references[1].base64, inline);
});

test("generation_id reference reports nonexistent generation", async () => {
  const manager = managerWithJobs();
  await assert.rejects(
    manager.resolveImageReferences({ reference_images: [{ generation_id: randomUUID(), index: 0 }] }),
    /REFERENCE_GENERATION_NOT_FOUND/,
  );
});

test("generation_id reference reports generation not completed", async () => {
  const manager = managerWithJobs();
  const source = jobFixture({ status: "RUNNING" });
  injectJob(manager, source);
  await assert.rejects(
    manager.resolveImageReferences({ reference_images: [{ generation_id: source.generationId, index: 0 }] }),
    /REFERENCE_GENERATION_NOT_COMPLETED.*RUNNING/,
  );
});

test("generation_id reference reports output index out of range", async () => {
  const manager = managerWithJobs();
  const source = await completedImageJob();
  injectJob(manager, source);
  await assert.rejects(
    manager.resolveImageReferences({ reference_images: [{ generation_id: source.generationId, index: 7 }] }),
    /REFERENCE_INDEX_OUT_OF_RANGE/,
  );
});

test("generation_id reference reports expired or purged generation", async () => {
  const manager = managerWithJobs();
  const source = await completedImageJob();
  await purgeGeneration(source);
  await assert.rejects(
    manager.resolveImageReferences({ reference_images: [{ generation_id: source.generationId, index: 0 }] }),
    /REFERENCE_GENERATION_EXPIRED/,
  );
});

test("generation_id reference rejects a video generation", async () => {
  const manager = managerWithJobs();
  const source = jobFixture({ kind: "video", status: "COMPLETED", outputs: [] });
  injectJob(manager, source);
  await assert.rejects(
    manager.resolveImageReferences({ reference_images: [{ generation_id: source.generationId, index: 0 }] }),
    /REFERENCE_IS_VIDEO/,
  );
});

test("include_base64=false payload is compact and always has a downloadUrl", async () => {
  const source = await completedImageJob();
  const payload = await outputPayload(source.outputs!, "https://mcp.example/media-service", false);
  assert.equal(payload[0].base64, undefined);
  assert.match(String(payload[0].downloadUrl), /^https:\/\/mcp\.example\/media-service\/media\//);
  assert.equal(payload[0].sha256, source.outputs![0].sha256);
});

test("completed generation metadata survives a disk round-trip", async () => {
  const source = await completedImageJob();
  await persistCompletedJob(source);
  const restored = await loadPersistedJob(source.generationId);
  assert.equal(restored?.status, "COMPLETED");
  assert.equal(restored?.outputs?.[0].sha256, source.outputs?.[0].sha256);
  assert.equal(restored?.outputs?.[0].index, 0);
});

function managerWithJobs(): JobManager {
  return new JobManager({} as never);
}

function injectJob(manager: JobManager, job: GenerationJob): void {
  (manager as unknown as { jobs: Map<string, GenerationJob> }).jobs.set(job.generationId, job);
}

async function completedImageJob(): Promise<GenerationJob> {
  const generationId = randomUUID();
  const output = await storeBase64(generationId, 0, tinyPng(), "image/png");
  return jobFixture({ generationId, status: "COMPLETED", outputs: [output] });
}

function jobFixture(overrides: Partial<GenerationJob> = {}): GenerationJob {
  const now = new Date().toISOString();
  return {
    generationId: randomUUID(),
    kind: "image",
    model: "gemini-2.5-flash-image",
    canonicalModel: "gemini-2.5-flash-image",
    arguments: {},
    estimatedCostUsd: 0.039,
    status: "QUEUING",
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function tinyPng(): string {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]).toString("base64");
}
