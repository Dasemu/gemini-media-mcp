import type { GenerationReferenceImage, InlineReferenceImage, ModelSpec, ReferenceImage, ToolArgument } from "./types.js";

export function normalizeArguments(model: ModelSpec, input: ToolArgument[]): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const specs = new Map(model.arguments.map((argument) => [argument.name, argument]));

  for (const argument of input) {
    if (!specs.has(argument.name)) throw new Error(`Unknown argument '${argument.name}' for model ${model.name}`);
    if (Object.hasOwn(result, argument.name)) throw new Error(`Duplicate argument '${argument.name}'`);
    result[argument.name] = argument.value;
  }

  for (const spec of model.arguments) {
    if (!Object.hasOwn(result, spec.name) && spec.default !== undefined) result[spec.name] = spec.default;
    if (spec.required && !Object.hasOwn(result, spec.name)) throw new Error(`Missing required argument '${spec.name}'`);

    const value = result[spec.name];
    if (value === undefined) continue;
    if (spec.allowedValues && !spec.allowedValues.some((allowed) => allowed === value)) {
      throw new Error(`Invalid '${spec.name}': ${JSON.stringify(value)}. Allowed: ${spec.allowedValues.map(String).join(", ")}`);
    }
    if (typeof value === "number") {
      if (spec.minimum !== undefined && value < spec.minimum) throw new Error(`'${spec.name}' must be >= ${spec.minimum}`);
      if (spec.maximum !== undefined && value > spec.maximum) throw new Error(`'${spec.name}' must be <= ${spec.maximum}`);
    }
  }

  if (typeof result.prompt !== "string" || result.prompt.trim().length === 0) throw new Error("'prompt' must be a non-empty string");
  if (String(result.prompt).length > 8000) throw new Error("'prompt' must be at most 8000 characters");

  if (model.type === "image" && result.reference_images !== undefined) {
    result.reference_images = normalizeReferenceImages(model, result.reference_images);
  }

  if (model.type === "video") {
    const resolution = String(result.resolution);
    const duration = Number(result.duration_seconds);
    if ((resolution === "1080p" || resolution === "4k") && duration !== 8) {
      throw new Error(`${resolution} video generation requires duration_seconds=8`);
    }
    if (result.with_audio !== true) throw new Error("Veo 3.1 always generates native audio; with_audio=false is not supported");
  }

  return result;
}

function normalizeReferenceImages(model: ModelSpec, input: unknown): ReferenceImage[] {
  if (!Array.isArray(input)) throw new Error("'reference_images' must be an array of {base64, mime_type} or {generation_id, index?} objects");
  const spec = model.arguments.find((argument) => argument.name === "reference_images");
  const maximumItems = spec?.maximumItems ?? 1;
  if (input.length < 1 || input.length > maximumItems) {
    throw new Error(`'reference_images' must contain between 1 and ${maximumItems} images for ${model.name}`);
  }

  const maxPerImageBytes = 20 * 1024 * 1024;
  const maxAggregateBytes = Math.floor((Number(process.env.MAX_REFERENCE_INPUT_MB) || 25) * 1024 * 1024);
  let aggregateBytes = 0;
  const normalized: ReferenceImage[] = [];

  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`reference_images[${index}] must be an object`);
    const record = value as Record<string, unknown>;
    const hasInline = Object.hasOwn(record, "base64") || Object.hasOwn(record, "mime_type");
    const hasGeneration = Object.hasOwn(record, "generation_id") || Object.hasOwn(record, "index");
    if (hasInline && hasGeneration) throw new Error(`reference_images[${index}] must use either {base64, mime_type} or {generation_id, index?}, not both`);

    if (hasGeneration) {
      if (typeof record.generation_id !== "string" || !isUuid(record.generation_id)) {
        throw new Error(`reference_images[${index}].generation_id must be a valid UUID`);
      }
      const outputIndex = record.index ?? 0;
      if (!Number.isInteger(outputIndex) || Number(outputIndex) < 0) {
        throw new Error(`reference_images[${index}].index must be a non-negative integer`);
      }
      normalized.push({ generation_id: record.generation_id, index: Number(outputIndex) } satisfies GenerationReferenceImage);
      continue;
    }

    const rawBase64 = record.base64;
    let mimeType = record.mime_type;
    if (typeof rawBase64 !== "string" || rawBase64.length === 0) throw new Error(`reference_images[${index}].base64 must be a non-empty string`);
    let base64: string = rawBase64;

    const dataUri = base64.match(/^data:(image\/(?:png|jpeg|webp));base64,(.+)$/s);
    if (dataUri) {
      mimeType ??= dataUri[1];
      base64 = dataUri[2];
    }
    base64 = base64.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || base64.length % 4 !== 0) {
      throw new Error(`reference_images[${index}].base64 is not valid standard base64`);
    }
    if (mimeType !== "image/png" && mimeType !== "image/jpeg" && mimeType !== "image/webp") {
      throw new Error(`reference_images[${index}].mime_type must be image/png, image/jpeg, or image/webp`);
    }

    const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
    const decodedBytes = Math.floor(base64.length * 3 / 4) - padding;
    if (decodedBytes <= 0 || decodedBytes > maxPerImageBytes) throw new Error(`reference_images[${index}] exceeds the 20 MiB per-image limit`);
    aggregateBytes += decodedBytes;
    if (aggregateBytes > maxAggregateBytes) throw new Error(`reference_images exceed the aggregate MAX_REFERENCE_INPUT_MB limit (${maxAggregateBytes} bytes)`);

    const header = Buffer.from(base64.slice(0, 24), "base64");
    if (!mimeMatchesHeader(mimeType, header)) throw new Error(`reference_images[${index}] content does not match ${mimeType}`);
    normalized.push({ base64, mime_type: mimeType } satisfies InlineReferenceImage);
  }
  return normalized;
}

function mimeMatchesHeader(mimeType: InlineReferenceImage["mime_type"], header: Buffer): boolean {
  if (mimeType === "image/png") return header.length >= 8 && header.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (mimeType === "image/jpeg") return header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff;
  return header.length >= 12 && header.subarray(0, 4).toString("ascii") === "RIFF" && header.subarray(8, 12).toString("ascii") === "WEBP";
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
