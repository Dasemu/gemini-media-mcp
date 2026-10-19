import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { normalizeArguments } from "./arguments.js";
import { MODEL_CATALOG, PRICING_REFERENCE_DATE, resolveModel } from "./catalog.js";
import { JobManager } from "./jobs.js";
import { maxInlineBytes, outputExists, outputPayload } from "./media.js";
import { publicMediaSigningConfigured, publicMediaTtlSeconds } from "./public-media.js";

const taskTraceIdSchema = z.string().uuid().optional().describe("Optional UUID used to group related calls.");
const inlineReferenceImageSchema = z.object({
  base64: z.string().min(1).describe("Raw standard base64 from query_tasks outputs[].base64; a data URI is also accepted."),
  mime_type: z.enum(["image/png", "image/jpeg", "image/webp"]),
}).strict();
const generationReferenceImageSchema = z.object({
  generation_id: z.string().uuid().describe("generationId of a completed image generation retained by this server."),
  index: z.number().int().nonnegative().default(0).describe("Zero-based output index; defaults to 0."),
}).strict();
const referenceImageSchema = z.union([inlineReferenceImageSchema, generationReferenceImageSchema]);
const argumentsSchema = z.array(z.object({
  name: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean(), z.array(referenceImageSchema)]),
})).describe("Kling-compatible name/value argument list.");
const videoOverlaySchema = z.object({
  text: z.string().trim().min(1).max(240).describe("Card text; never logged."),
  kicker: z.string().trim().min(1).max(40).optional().describe("Optional uppercase label displayed above the text."),
  style: z.enum(["normal", "cta"]).default("normal"),
  start_time: z.number().finite().min(0).max(600).describe("Seconds from the start of the base video."),
  duration: z.number().finite().min(0.5).max(60).describe("Seconds the card remains visible, including 250ms fades."),
}).strict();

export function registerTools(server: McpServer, jobs: JobManager): void {
  const retentionHours = Number(process.env.MEDIA_RETENTION_HOURS) || 168;
  server.tool("who_am_i", "List available Google image/video models, accepted arguments and current cost estimates.", {
    taskTraceId: taskTraceIdSchema,
  }, async ({ taskTraceId }) => jsonResult({
    service: "Gemini Veo Media MCP",
    taskTraceId,
    backend: "Gemini Developer API",
    authentication: { googleCredentialsConfigured: Boolean(process.env.GEMINI_API_KEY), credentialsExposed: false },
    pricingReferenceDate: PRICING_REFERENCE_DATE,
    costCaveat: "Estimates cover output image/video pricing only; prompt input tokens and optional grounding charges are excluded.",
    resultDelivery: {
      inlineBase64AggregateLimitBytes: maxInlineBytes,
      inlineBase64AggregateLimitMiB: maxInlineBytes / 1024 / 1024,
      oversizedAlternative: "Protected same-domain downloadUrl; use the same connector HTTP Basic credentials.",
      recommendedDelivery: "publicUrl is an HMAC-signed same-domain URL that Meta can fetch directly without credentials.",
      publicUrl: { configured: publicMediaSigningConfigured(), ttlSeconds: publicMediaTtlSeconds(), authentication: "expiring HMAC signature in query string" },
      queryTasksArguments: [
        { name: "generationId", required: true, format: "uuid" },
        { name: "taskTraceId", required: false, format: "uuid" },
        { name: "include_base64", required: false, allowedValues: [true, false], default: false, description: "Default false: compact outputs include publicUrl and protected downloadUrl. Set true only when inline bytes are explicitly required." },
      ],
    },
    generationRetention: {
      ttlHours: retentionHours,
      ttlDays: retentionHours / 24,
      storage: "disk manifests and media indexed by generationId",
      behaviorAfterExpiry: "References fail with REFERENCE_GENERATION_EXPIRED while the purge tombstone is retained.",
    },
    referenceImages: {
      argumentName: "reference_images",
      variants: [
        { format: '{generation_id:uuid,index?:integer=0}', recommended: true, description: "Reuses a retained completed image entirely server-side; no base64 enters the client context." },
        { format: '{base64:string,mime_type:"image/png"|"image/jpeg"|"image/webp"}', recommended: false, description: "Backward-compatible inline image input." },
      ],
      mixingAllowed: true,
      modelLimits: { "gemini-2.5-flash-image": 3, "gemini-3-pro-image": 14, "gemini-3.1-flash-image": 14, "gemini-3.1-flash-lite-image": 14 },
    },
    videoComposition: {
      tool: "compose_video_overlay",
      backend: "local Pillow + ffmpeg; no Google generation call and no media crosses the client context",
      asynchronous: true,
      baseRequirements: { kind: "video", status: "COMPLETED", mimeType: "video/mp4", aspectRatio: "9:16", retainedByThisServer: true },
      overlayArguments: [
        { name: "text", required: true, maximumCharacters: 240 },
        { name: "kicker", required: false, maximumCharacters: 40 },
        { name: "style", required: false, allowedValues: ["normal", "cta"], default: "normal" },
        { name: "start_time", required: true, unit: "seconds", minimum: 0 },
        { name: "duration", required: true, unit: "seconds", minimum: 0.5, maximum: 60 },
      ],
      overlayCount: { minimum: 1, maximum: 10 },
      output: "A new retained generationId polled through query_tasks; use outputs[].publicUrl directly in SocialMCP publish_post.",
    },
    models: {
      image: MODEL_CATALOG.filter((model) => model.type === "image"),
      video: MODEL_CATALOG.filter((model) => model.type === "video"),
    },
  }));

  server.tool("generate_image", "Queue a Gemini image generation job and return immediately.", {
    model: z.string().min(1), arguments: argumentsSchema, taskTraceId: taskTraceIdSchema,
  }, async ({ model, arguments: inputArguments, taskTraceId }) => {
    const spec = resolveModel(model, "image");
    const args = await jobs.resolveImageReferences(normalizeArguments(spec, inputArguments));
    const job = jobs.submit("image", model, args, taskTraceId);
    return jsonResult(submitPayload(job));
  });

  server.tool("generate_video", "Queue a Veo video generation job and return immediately.", {
    model: z.string().min(1), arguments: argumentsSchema, taskTraceId: taskTraceIdSchema,
  }, async ({ model, arguments: inputArguments, taskTraceId }) => {
    const spec = resolveModel(model, "video");
    const args = normalizeArguments(spec, inputArguments);
    const job = jobs.submit("video", model, args, taskTraceId);
    return jsonResult(submitPayload(job));
  });

  server.tool("compose_video_overlay", "Queue a local Pillow/ffmpeg composition over a retained completed 9:16 video. Returns a new generationId immediately; poll it with query_tasks and publish outputs[].publicUrl directly.", {
    base_generation_id: z.string().uuid().describe("generationId of a retained COMPLETED video/mp4 from this server."),
    overlays: z.array(videoOverlaySchema).min(1).max(10),
    taskTraceId: taskTraceIdSchema,
  }, async ({ base_generation_id, overlays, taskTraceId }) => {
    const job = await jobs.submitComposition(base_generation_id, overlays, taskTraceId);
    return jsonResult(submitPayload(job));
  });

  server.tool("query_tasks", "Poll either an image or video generation job. Compact output is the default and includes an expiring publicUrl that can be passed directly to SocialMCP publish_post.", {
    generationId: z.string().uuid(),
    taskTraceId: taskTraceIdSchema,
    include_base64: z.boolean().default(false).describe("Default false. Outputs include publicUrl and omit base64. Set true only for explicit inline delivery."),
  }, async ({ generationId, taskTraceId, include_base64 }) => {
    let job = jobs.get(generationId);
    if (!job) return jsonResult({ generationId, status: "FAILED", error: { code: "JOB_NOT_FOUND", message: "Unknown or expired generationId", retryable: false } }, true);
    if (taskTraceId && job.taskTraceId && taskTraceId !== job.taskTraceId) {
      return jsonResult({ generationId, status: "FAILED", error: { code: "TRACE_ID_MISMATCH", message: "taskTraceId does not match this generation", retryable: false } }, true);
    }
    job = await jobs.refresh(job);
    const payload: Record<string, unknown> = {
      generationId: job.generationId, taskTraceId: job.taskTraceId, status: job.status, type: job.kind, model: job.model,
      estimatedCostUsd: job.estimatedCostUsd, createdAt: job.createdAt, startedAt: job.startedAt, completedAt: job.completedAt,
    };
    if (job.status === "FAILED") payload.error = job.error;
    if (job.status === "COMPLETED" && job.outputs) {
      const allPresent = (await Promise.all(job.outputs.map(outputExists))).every(Boolean);
      if (!allPresent) return jsonResult({ ...payload, status: "FAILED", error: { code: "MEDIA_EXPIRED", message: "Generated media is no longer available", retryable: false } }, true);
      payload.outputs = await outputPayload(job.outputs, process.env.PUBLIC_BASE_URL || "http://127.0.0.1:8087", include_base64);
    }
    return jsonResult(payload, job.status === "FAILED");
  });

  server.tool("get_usage", "Return process-local estimated generation usage; Google does not expose remaining billing quota here.", {
    taskTraceId: taskTraceIdSchema,
  }, async ({ taskTraceId }) => jsonResult({ taskTraceId, ...jobs.usage(), pricingReferenceDate: PRICING_REFERENCE_DATE }));
}

function submitPayload(job: ReturnType<JobManager["submit"]>): Record<string, unknown> {
  return { generationId: job.generationId, status: "QUEUING", model: job.model, estimatedCostUsd: job.estimatedCostUsd, creditsConsumed_o_costEstimado: { amount: job.estimatedCostUsd, currency: "USD", kind: "estimate" } };
}

function jsonResult(payload: Record<string, unknown>, isError = false): { content: Array<{ type: "text"; text: string }>; isError?: boolean } {
  return { content: [{ type: "text", text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}
