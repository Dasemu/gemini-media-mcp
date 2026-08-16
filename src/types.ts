export type JobStatus = "QUEUING" | "RUNNING" | "COMPLETED" | "FAILED";
export type JobKind = "image" | "video";

export interface ToolArgument {
  name: string;
  value: unknown;
}

export interface StoredOutput {
  index: number;
  path: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface InlineReferenceImage {
  base64: string;
  mime_type: "image/png" | "image/jpeg" | "image/webp";
}

export interface GenerationReferenceImage {
  generation_id: string;
  index: number;
}

export type ReferenceImage = InlineReferenceImage | GenerationReferenceImage;

export interface VideoOverlay {
  text: string;
  kicker?: string;
  style: "normal" | "cta";
  start_time: number;
  duration: number;
}

export interface JobError {
  code: string;
  message: string;
  providerStatus?: number;
  retryable: false;
}

export interface GenerationJob {
  generationId: string;
  taskTraceId?: string;
  kind: JobKind;
  model: string;
  canonicalModel: string;
  arguments: Record<string, unknown>;
  estimatedCostUsd: number;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  updatedAt: string;
  operation?: unknown;
  outputs?: StoredOutput[];
  error?: JobError;
}

export interface ArgumentSpec {
  name: string;
  required: boolean;
  description: string;
  allowedValues?: Array<string | number | boolean>;
  default?: string | number | boolean;
  minimum?: number;
  maximum?: number;
  maximumItems?: number;
  format?: string;
}

export interface ModelSpec {
  name: string;
  aliases: string[];
  description: string;
  type: JobKind;
  canonicalApiModel: string;
  arguments: ArgumentSpec[];
  pricing: {
    currency: "USD";
    referenceDate: string;
    basis: string;
    rates: Record<string, number>;
    source: string;
  };
}
