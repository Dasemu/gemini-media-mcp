import type { ModelSpec } from "./types.js";

export const PRICING_REFERENCE_DATE = "2026-08-14";
export const PRICING_SOURCE = "https://ai.google.dev/gemini-api/docs/pricing";

const commonImageRatios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const extendedFlashRatios = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];

function imageArguments(resolutions: string[], ratios = commonImageRatios, maximumReferenceImages = 14): ModelSpec["arguments"] {
  return [
    { name: "prompt", required: true, description: "Detailed text prompt for the image." },
    {
      name: "reference_images",
      required: false,
      description: "Reference images. Prefer {generation_id,index?} to reuse a completed server-side image without moving base64 through the client; inline {base64,mime_type} remains supported.",
      format: 'array<({generation_id:uuid,index?:integer=0}|{base64:string,mime_type:"image/png"|"image/jpeg"|"image/webp"})>',
      maximumItems: maximumReferenceImages,
    },
    { name: "resolution", required: false, description: "Requested output image size.", allowedValues: resolutions, default: resolutions.includes("1K") ? "1K" : resolutions[0] },
    { name: "aspect_ratio", required: false, description: "Output image aspect ratio.", allowedValues: ratios, default: "1:1" },
    { name: "image_count", required: false, description: "Number of independent images. The server makes one provider request per image.", allowedValues: [1, 2, 3, 4], default: 1 },
  ];
}

function videoArguments(resolutions: string[]): ModelSpec["arguments"] {
  return [
    { name: "prompt", required: true, description: "Video prompt; may include dialogue, sound and ambience cues." },
    { name: "resolution", required: false, description: "Output resolution. 1080p and 4k require an 8 second duration.", allowedValues: resolutions, default: "720p" },
    { name: "aspect_ratio", required: false, description: "Output orientation.", allowedValues: ["16:9", "9:16"], default: "16:9" },
    { name: "duration_seconds", required: false, description: "Generated clip duration.", allowedValues: [4, 6, 8], default: 8 },
    { name: "with_audio", required: false, description: "Veo 3.1 native audio is always enabled; false is unsupported.", allowedValues: [true], default: true },
    { name: "seed", required: false, description: "Optional seed (improves repeatability but does not guarantee determinism).", minimum: 0, maximum: 2147483647 },
  ];
}

export const MODEL_CATALOG: ModelSpec[] = [
  {
    name: "gemini-3-pro-image",
    aliases: ["nano-banana-pro"],
    description: "Nano Banana Pro; professional assets, complex instructions and high-quality text rendering up to 4K.",
    type: "image",
    canonicalApiModel: "gemini-3-pro-image",
    arguments: imageArguments(["1K", "2K", "4K"], commonImageRatios, 14),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per output image (text input/tokens excluded)", rates: { "1K": 0.134, "2K": 0.134, "4K": 0.24 }, source: PRICING_SOURCE },
  },
  {
    name: "gemini-3.1-flash-image",
    aliases: ["nano-banana-2"],
    description: "Nano Banana 2; recommended balance of quality, latency and cost, with 0.5K through 4K output.",
    type: "image",
    canonicalApiModel: "gemini-3.1-flash-image",
    arguments: imageArguments(["0.5K", "1K", "2K", "4K"], extendedFlashRatios, 14),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per output image (text input/tokens excluded)", rates: { "0.5K": 0.045, "1K": 0.067, "2K": 0.101, "4K": 0.151 }, source: PRICING_SOURCE },
  },
  {
    name: "gemini-3.1-flash-lite-image",
    aliases: ["nano-banana-2-lite"],
    description: "Nano Banana 2 Lite; lowest-latency and lowest-cost 1K image generation.",
    type: "image",
    canonicalApiModel: "gemini-3.1-flash-lite-image",
    arguments: imageArguments(["1K"], commonImageRatios, 14),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per output image (text input/tokens excluded)", rates: { "1K": 0.0336 }, source: PRICING_SOURCE },
  },
  {
    name: "gemini-2.5-flash-image",
    aliases: ["nano-banana"],
    description: "Original Nano Banana; efficient fixed-resolution 1K image generation.",
    type: "image",
    canonicalApiModel: "gemini-2.5-flash-image",
    arguments: imageArguments(["1K"], commonImageRatios, 3),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per output image (text input/tokens excluded)", rates: { "1K": 0.039 }, source: PRICING_SOURCE },
  },
  {
    name: "veo-3.1",
    aliases: ["veo-3.1-standard"],
    description: "Veo 3.1 Preview standard; highest-quality video with native audio, up to 4K.",
    type: "video",
    canonicalApiModel: "veo-3.1-generate-preview",
    arguments: videoArguments(["720p", "1080p", "4k"]),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per generated second, with audio", rates: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 }, source: PRICING_SOURCE },
  },
  {
    name: "veo-3.1-fast",
    aliases: [],
    description: "Veo 3.1 Fast Preview; optimized for fast, high-throughput social and advertising workflows.",
    type: "video",
    canonicalApiModel: "veo-3.1-fast-generate-preview",
    arguments: videoArguments(["720p", "1080p", "4k"]),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per generated second, with audio", rates: { "720p": 0.1, "1080p": 0.12, "4k": 0.3 }, source: PRICING_SOURCE },
  },
  {
    name: "veo-3.1-lite",
    aliases: [],
    description: "Veo 3.1 Lite Preview; lowest-cost native-audio video generation at 720p or 1080p.",
    type: "video",
    canonicalApiModel: "veo-3.1-lite-generate-preview",
    arguments: videoArguments(["720p", "1080p"]),
    pricing: { currency: "USD", referenceDate: PRICING_REFERENCE_DATE, basis: "per generated second, with audio", rates: { "720p": 0.05, "1080p": 0.08 }, source: PRICING_SOURCE },
  },
];

export function resolveModel(requested: string, type?: "image" | "video"): ModelSpec {
  const normalized = requested.trim().toLowerCase();
  const model = MODEL_CATALOG.find((item) =>
    (item.name.toLowerCase() === normalized || item.aliases.some((alias) => alias.toLowerCase() === normalized)) &&
    (!type || item.type === type),
  );
  if (!model) throw new Error(`Unsupported ${type ?? "generation"} model: ${requested}`);
  return model;
}

export function estimateCost(model: ModelSpec, args: Record<string, unknown>): number {
  if (model.type === "image") {
    const resolution = String(args.resolution ?? "1K");
    const count = Number(args.image_count ?? 1);
    return roundUsd((model.pricing.rates[resolution] ?? 0) * count);
  }
  const resolution = String(args.resolution ?? "720p");
  const seconds = Number(args.duration_seconds ?? 8);
  return roundUsd((model.pricing.rates[resolution] ?? 0) * seconds);
}

function roundUsd(value: number): number {
  return Math.round(value * 10000) / 10000;
}
