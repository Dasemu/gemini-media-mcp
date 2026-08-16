import { GoogleGenAI } from "@google/genai";
import path from "node:path";
import { mediaDir, registerDownloaded, removeOutputs, storeBase64 } from "./media.js";
import { withRetry } from "./retry.js";
import type { GenerationJob, StoredOutput } from "./types.js";

export class GoogleMediaProvider {
  private readonly client: GoogleGenAI;

  constructor(apiKey = process.env.GEMINI_API_KEY) {
    this.client = new GoogleGenAI({ apiKey: apiKey || "missing-gemini-api-key" });
  }

  async generateImages(job: GenerationJob): Promise<StoredOutput[]> {
    this.assertConfigured();
    const count = Number(job.arguments.image_count ?? 1);
    const outputs: StoredOutput[] = [];

    try {
      for (let index = 0; index < count; index += 1) {
        const references = (job.arguments.reference_images as Array<{ base64: string; mime_type: string }> | undefined) ?? [];
        const response: any = await withRetry("generate_image", () => this.client.models.generateContent({
          model: job.canonicalModel,
          contents: [{
            role: "user",
            parts: [
              ...references.map((reference) => ({ inlineData: { data: reference.base64, mimeType: reference.mime_type } })),
              { text: String(job.arguments.prompt) },
            ],
          }],
          config: {
            responseModalities: ["IMAGE"],
            imageConfig: {
              aspectRatio: String(job.arguments.aspect_ratio),
              ...(job.canonicalModel !== "gemini-2.5-flash-image" ? { imageSize: String(job.arguments.resolution) } : {}),
            },
          },
        }));

        const parts = response?.candidates?.flatMap((candidate: any) => candidate?.content?.parts ?? []) ?? [];
        const imagePart = parts.find((part: any) => part?.inlineData?.data);
        if (!imagePart?.inlineData?.data) {
          const reason = response?.promptFeedback?.blockReason || response?.candidates?.[0]?.finishReason;
          throw new Error(reason ? `Image generation produced no image (${reason})` : "Image generation produced no image");
        }
        outputs.push(await storeBase64(job.generationId, index, imagePart.inlineData.data, imagePart.inlineData.mimeType || "image/png"));
      }
      return outputs;
    } catch (error) {
      await removeOutputs(outputs);
      throw error;
    }
  }

  async submitVideo(job: GenerationJob): Promise<unknown> {
    this.assertConfigured();
    return withRetry("submit_video", () => this.client.models.generateVideos({
      model: job.canonicalModel,
      prompt: String(job.arguments.prompt),
      config: {
        aspectRatio: String(job.arguments.aspect_ratio),
        durationSeconds: Number(job.arguments.duration_seconds),
        resolution: String(job.arguments.resolution),
        numberOfVideos: 1,
        ...(job.arguments.seed !== undefined ? { seed: Number(job.arguments.seed) } : {}),
      },
    }));
  }

  async pollVideo(job: GenerationJob): Promise<{ done: boolean; operation: unknown; outputs?: StoredOutput[] }> {
    this.assertConfigured();
    if (!job.operation) return { done: false, operation: job.operation };
    const operation: any = await withRetry("poll_video", () => this.client.operations.getVideosOperation({ operation: job.operation as any }));
    if (!operation?.done) return { done: false, operation };
    if (operation.error) {
      const error = new Error(operation.error.message || "Veo generation failed") as Error & { code?: number };
      error.code = operation.error.code;
      throw error;
    }

    const videos = operation?.response?.generatedVideos ?? [];
    if (videos.length === 0) throw new Error("Veo operation completed without a video");
    const outputs: StoredOutput[] = [];
    for (let index = 0; index < videos.length; index += 1) {
      const video = videos[index]?.video;
      if (video?.videoBytes) {
        outputs.push(await storeBase64(job.generationId, index, video.videoBytes, video.mimeType || "video/mp4"));
        continue;
      }
      if (!video) throw new Error("Veo returned an invalid video reference");
      const tempPath = path.join(mediaDir, `${job.generationId}-${index}.download`);
      await withRetry("download_video", () => this.client.files.download({ file: video, downloadPath: tempPath }));
      outputs.push(await registerDownloaded(job.generationId, index, tempPath, video.mimeType || "video/mp4"));
    }
    return { done: true, operation, outputs };
  }

  private assertConfigured(): void {
    if (!process.env.GEMINI_API_KEY) throw new Error("GEMINI_API_KEY is not configured on the MCP server");
  }
}
