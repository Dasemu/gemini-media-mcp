import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { estimateCost, resolveModel } from "./catalog.js";
import { audit, auditError, providerStatus } from "./log.js";
import { generationWasPurged, loadPersistedJob, loadPersistedJobs, outputExists, persistCompletedJob, purgeGeneration } from "./media.js";
import { composeVideoOverlay } from "./compositor.js";
import { GoogleMediaProvider } from "./provider.js";
import type { GenerationJob, InlineReferenceImage, JobKind, ReferenceImage, VideoOverlay } from "./types.js";

export class JobManager {
  private readonly jobs = new Map<string, GenerationJob>();
  private estimatedSubmittedUsd = 0;
  private estimatedCompletedUsd = 0;

  constructor(private readonly provider = new GoogleMediaProvider()) {}

  submit(kind: JobKind, requestedModel: string, args: Record<string, unknown>, taskTraceId?: string): GenerationJob {
    const model = resolveModel(requestedModel, kind);
    const now = new Date().toISOString();
    const job: GenerationJob = {
      generationId: randomUUID(), taskTraceId, kind, model: model.name, canonicalModel: model.canonicalApiModel,
      arguments: args, estimatedCostUsd: estimateCost(model, args), status: "QUEUING", createdAt: now, updatedAt: now,
    };
    this.jobs.set(job.generationId, job);
    this.estimatedSubmittedUsd += job.estimatedCostUsd;
    audit("generation_queued", {
      generationId: job.generationId, taskTraceId, kind, model: job.model,
      referenceImageCount: Array.isArray(args.reference_images) ? args.reference_images.length : 0,
      estimatedCostUsd: job.estimatedCostUsd,
    });
    setImmediate(() => void (kind === "image" ? this.runImage(job) : this.runVideoSubmit(job)));
    return job;
  }

  get(generationId: string): GenerationJob | undefined { return this.jobs.get(generationId); }

  async submitComposition(baseGenerationId: string, overlays: VideoOverlay[], taskTraceId?: string): Promise<GenerationJob> {
    let base = this.jobs.get(baseGenerationId);
    if (!base) {
      base = await loadPersistedJob(baseGenerationId);
      if (base) this.jobs.set(base.generationId, base);
    }
    if (!base) {
      const code = await generationWasPurged(baseGenerationId) ? "COMPOSE_BASE_EXPIRED" : "COMPOSE_BASE_NOT_FOUND";
      throw new Error(`${code}: base_generation_id ${baseGenerationId} is unavailable`);
    }
    if (base.kind !== "video") throw new Error(`COMPOSE_BASE_IS_NOT_VIDEO: base_generation_id ${baseGenerationId} is an image generation`);
    if (base.status !== "COMPLETED" || !base.outputs) {
      throw new Error(`COMPOSE_BASE_NOT_COMPLETED: base_generation_id ${baseGenerationId} has status ${base.status}; wait for COMPLETED`);
    }
    const baseOutput = base.outputs.find((output) => output.index === 0 && output.mimeType === "video/mp4");
    if (!baseOutput) throw new Error(`COMPOSE_BASE_OUTPUT_MISSING: base_generation_id ${baseGenerationId} has no video/mp4 output at index 0`);
    if (!(await outputExists(baseOutput))) throw new Error(`COMPOSE_BASE_EXPIRED: base_generation_id ${baseGenerationId} media has expired or was purged`);

    const now = new Date().toISOString();
    const job: GenerationJob = {
      generationId: randomUUID(), taskTraceId, kind: "video", model: "ffmpeg-overlay", canonicalModel: "local-ffmpeg-overlay-v1",
      arguments: { base_generation_id: baseGenerationId, overlays }, estimatedCostUsd: 0, status: "QUEUING", createdAt: now, updatedAt: now,
    };
    this.jobs.set(job.generationId, job);
    audit("composition_queued", { generationId: job.generationId, taskTraceId, baseGenerationId, overlayCount: overlays.length });
    setImmediate(() => void this.runComposition(job, baseOutput, overlays));
    return job;
  }

  async restoreCompletedJobs(): Promise<number> {
    const restored = await loadPersistedJobs();
    for (const job of restored) {
      this.jobs.set(job.generationId, job);
      this.estimatedCompletedUsd += job.estimatedCostUsd;
    }
    if (restored.length > 0) audit("completed_jobs_restored", { count: restored.length });
    return restored.length;
  }

  async resolveImageReferences(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const references = args.reference_images as ReferenceImage[] | undefined;
    if (!references) return args;
    const resolved: InlineReferenceImage[] = [];
    const maxAggregateBytes = Math.floor((Number(process.env.MAX_REFERENCE_INPUT_MB) || 25) * 1024 * 1024);
    let aggregateBytes = 0;

    for (const [position, reference] of references.entries()) {
      if ("base64" in reference) {
        aggregateBytes += decodedBase64Size(reference.base64);
        resolved.push(reference);
      } else {
        let source = this.jobs.get(reference.generation_id);
        if (!source) {
          source = await loadPersistedJob(reference.generation_id);
          if (source) this.jobs.set(source.generationId, source);
        }
        if (!source) {
          if (await generationWasPurged(reference.generation_id)) {
            throw new Error(`REFERENCE_GENERATION_EXPIRED: reference_images[${position}] generation_id ${reference.generation_id} has expired or was purged by retention`);
          }
          throw new Error(`REFERENCE_GENERATION_NOT_FOUND: reference_images[${position}] generation_id ${reference.generation_id} does not exist`);
        }
        if (source.kind === "video") {
          throw new Error(`REFERENCE_IS_VIDEO: reference_images[${position}] generation_id ${reference.generation_id} is a video generation and cannot be used as an image reference`);
        }
        if (source.status !== "COMPLETED" || !source.outputs) {
          throw new Error(`REFERENCE_GENERATION_NOT_COMPLETED: reference_images[${position}] generation_id ${reference.generation_id} has status ${source.status}; wait for COMPLETED`);
        }
        const output = source.outputs.find((candidate) => candidate.index === reference.index);
        if (!output) {
          const available = source.outputs.map((candidate) => candidate.index).sort((a, b) => a - b);
          throw new Error(`REFERENCE_INDEX_OUT_OF_RANGE: reference_images[${position}] index ${reference.index} is unavailable for generation ${reference.generation_id}; available indexes: ${available.join(", ") || "none"}`);
        }
        if (!(await outputExists(output))) {
          throw new Error(`REFERENCE_GENERATION_EXPIRED: reference_images[${position}] generation_id ${reference.generation_id} output ${reference.index} has expired or was purged by retention`);
        }
        if (output.mimeType !== "image/png" && output.mimeType !== "image/jpeg" && output.mimeType !== "image/webp") {
          throw new Error(`REFERENCE_IS_VIDEO: reference_images[${position}] generation_id ${reference.generation_id} output ${reference.index} is ${output.mimeType}, not an image`);
        }
        aggregateBytes += output.sizeBytes;
        resolved.push({ base64: (await readFile(output.path)).toString("base64"), mime_type: output.mimeType });
      }
      if (aggregateBytes > maxAggregateBytes) {
        throw new Error(`REFERENCE_INPUT_TOO_LARGE: reference_images exceed the aggregate MAX_REFERENCE_INPUT_MB limit (${maxAggregateBytes} bytes)`);
      }
    }
    return { ...args, reference_images: resolved };
  }

  async refresh(job: GenerationJob): Promise<GenerationJob> {
    if (job.kind !== "video" || job.status !== "RUNNING" || !job.operation) return job;
    try {
      const result = await this.provider.pollVideo(job);
      job.operation = result.operation;
      job.updatedAt = new Date().toISOString();
      if (result.done && result.outputs) await this.complete(job, result.outputs);
    } catch (error) {
      this.fail(job, error);
    }
    return job;
  }

  usage(): Record<string, unknown> {
    const jobs = [...this.jobs.values()];
    return {
      providerQuotaAvailable: false,
      providerQuotaMessage: "The Gemini Developer API does not expose remaining account spend/quota through this generation API.",
      scope: "current process plus completed generations restored from retained disk manifests",
      jobsSubmitted: jobs.length,
      jobsCompleted: jobs.filter((job) => job.status === "COMPLETED").length,
      jobsFailed: jobs.filter((job) => job.status === "FAILED").length,
      jobsInProgress: jobs.filter((job) => job.status === "QUEUING" || job.status === "RUNNING").length,
      estimatedSubmittedCostUsd: Math.round(this.estimatedSubmittedUsd * 10000) / 10000,
      estimatedCompletedCostUsd: Math.round(this.estimatedCompletedUsd * 10000) / 10000,
    };
  }

  startCleanup(retentionHours: number): NodeJS.Timeout {
    const interval = setInterval(() => void this.cleanup(retentionHours), 15 * 60 * 1000);
    interval.unref();
    return interval;
  }

  async cleanup(retentionHours: number): Promise<void> {
    const cutoff = Date.now() - retentionHours * 60 * 60 * 1000;
    for (const [id, job] of this.jobs) {
      if ((job.status === "COMPLETED" || job.status === "FAILED") && new Date(job.updatedAt).getTime() < cutoff) {
        await purgeGeneration(job);
        this.jobs.delete(id);
        audit("generation_expired", { generationId: id, retentionHours });
      }
    }
  }

  private async runImage(job: GenerationJob): Promise<void> {
    this.start(job);
    try { await this.complete(job, await this.provider.generateImages(job)); }
    catch (error) { this.fail(job, error); }
  }

  private async runVideoSubmit(job: GenerationJob): Promise<void> {
    this.start(job);
    try {
      job.operation = await this.provider.submitVideo(job);
      job.updatedAt = new Date().toISOString();
      audit("video_operation_submitted", { generationId: job.generationId, model: job.model });
    } catch (error) { this.fail(job, error); }
  }

  private async runComposition(job: GenerationJob, baseOutput: NonNullable<GenerationJob["outputs"]>[number], overlays: VideoOverlay[]): Promise<void> {
    this.start(job);
    try { await this.complete(job, await composeVideoOverlay(job.generationId, baseOutput, overlays)); }
    catch (error) { this.fail(job, error); }
  }

  private start(job: GenerationJob): void {
    job.status = "RUNNING"; job.startedAt = new Date().toISOString(); job.updatedAt = job.startedAt;
    audit("generation_started", { generationId: job.generationId, kind: job.kind, model: job.model });
  }

  private async complete(job: GenerationJob, outputs: NonNullable<GenerationJob["outputs"]>): Promise<void> {
    job.status = "COMPLETED"; job.outputs = outputs; job.operation = undefined; job.completedAt = new Date().toISOString(); job.updatedAt = job.completedAt;
    await persistCompletedJob(job);
    job.arguments = {};
    this.estimatedCompletedUsd += job.estimatedCostUsd;
    const durationMs = job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : undefined;
    audit("generation_completed", { generationId: job.generationId, kind: job.kind, model: job.model, outputCount: outputs.length, outputBytes: outputs.reduce((sum, output) => sum + output.sizeBytes, 0), durationMs, estimatedCostUsd: job.estimatedCostUsd });
  }

  private fail(job: GenerationJob, error: unknown): void {
    const status = providerStatus(error);
    const rawMessage = error instanceof Error ? error.message : String(error);
    job.status = "FAILED"; job.updatedAt = new Date().toISOString(); job.completedAt = job.updatedAt;
    job.arguments = {};
    job.error = { code: classifyError(rawMessage, status), message: rawMessage.slice(0, 2000), ...(status ? { providerStatus: status } : {}), retryable: false };
    auditError("generation_failed", error, { generationId: job.generationId, kind: job.kind, model: job.model, durationMs: job.startedAt ? Date.now() - new Date(job.startedAt).getTime() : undefined });
  }
}

function decodedBase64Size(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor(base64.length * 3 / 4) - padding;
}

function classifyError(message: string, status?: number): string {
  const composeCode = message.match(/^(COMPOSE_[A-Z_]+):/)?.[1];
  if (composeCode) return composeCode;
  if (message.includes("GEMINI_API_KEY")) return "SERVER_NOT_CONFIGURED";
  if (status === 429) return "PROVIDER_RATE_LIMITED";
  if (status && status >= 500) return "PROVIDER_UNAVAILABLE";
  if (/safety|blocked|moderation|policy/i.test(message)) return "CONTENT_POLICY_BLOCKED";
  if (status === 400 || /invalid|unsupported|required|prompt/i.test(message)) return "INVALID_REQUEST";
  if (status === 401 || status === 403) return "PROVIDER_AUTH_ERROR";
  return "GENERATION_FAILED";
}
