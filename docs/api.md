# API and Google credentials

As of the reference date **2026-08-14**, Veo 3.1 Standard, Fast and Lite are available on the paid tier of the **Gemini Developer API**. Both image and video generation therefore use only `GEMINI_API_KEY`; `GOOGLE_APPLICATION_CREDENTIALS`, `GCP_PROJECT_ID` and `GCP_LOCATION` are not required for the models exposed here.

Official sources:

- Image: https://ai.google.dev/gemini-api/docs/image-generation
- Veo: https://ai.google.dev/gemini-api/docs/veo
- Pricing: https://ai.google.dev/gemini-api/docs/pricing

The key is never part of MCP schemas or responses. The process starts without a key so that `who_am_i` and health checks work, but jobs fail with `SERVER_NOT_CONFIGURED` until it is configured.

## Tools

- `who_am_i`: catalog by type, aliases, arguments, constraints and official reference prices.
- `generate_image`: non-blocking submission of one or more images.
- `generate_video`: non-blocking submission of one Veo video.
- `compose_video_overlay`: non-blocking local composition of Pillow cards over a retained video, producing a new `generationId`.
- `query_tasks`: shared polling and final delivery.
- `get_usage`: cumulative estimates since the last start. Google does not expose the remaining billing balance through this API.

`arguments` is always a list of `{ "name": ..., "value": ... }`, compatible with the Kling connector pattern. Veo 3.1 always generates audio; `with_audio=false` is rejected explicitly.

## Chaining reference images

`generate_image` accepts `reference_images` in two mixable variants. The recommended one references a finished generation by UUID, so the bytes travel directly from the server disk to Gemini and never pass through the LLM context:

```json
{
  "model": "gemini-3.1-flash-image",
  "arguments": [
    { "name": "prompt", "value": "Create slide 2, keeping exactly the visual style of the reference" },
    {
      "name": "reference_images",
      "value": [
        { "generation_id": "<generationId of the previous slide>", "index": 0 }
      ]
    },
    { "name": "aspect_ratio", "value": "4:5" },
    { "name": "resolution", "value": "1K" }
  ]
}
```

The inline variant remains supported: `{ "base64": "...", "mime_type": "image/png" }`. A single array can mix ID-based and inline references. PNG, JPEG and WebP are accepted, up to 20 MiB per inline reference and 25 MiB aggregate per request. Count limits are 3 references for Gemini 2.5 Flash Image and 14 for the exposed Gemini 3 models. References are never written to logs.

ID-based references produce clear error codes: `REFERENCE_GENERATION_NOT_FOUND`, `REFERENCE_GENERATION_NOT_COMPLETED`, `REFERENCE_INDEX_OUT_OF_RANGE`, `REFERENCE_GENERATION_EXPIRED` and `REFERENCE_IS_VIDEO`.

## Composing cards over a video

`compose_video_overlay` takes the `generationId` of a vertical 9:16 video that is already `COMPLETED`, plus 1 to 10 timed cards. It immediately returns a new `generationId`; the work is done locally with Pillow, Poppins Bold and ffmpeg, keeps the original audio, and is queried with the same `query_tasks`:

```json
{
  "base_generation_id": "<generationId of the Veo video>",
  "overlays": [
    { "kicker": "HOOK", "text": "Your team does not need more tools", "style": "normal", "start_time": 0.6, "duration": 2.5 },
    { "kicker": "NEXT STEP", "text": "Automate the repetitive work", "style": "cta", "start_time": 4.8, "duration": 2.5 }
  ]
}
```

The base video is neither downloaded nor regenerated: its bytes go from the retained store to the ffmpeg process. The result is persisted as another `video/mp4` generation with real size and SHA-256, normal retention and the same `downloadUrl`/`publicUrl`. Timings must fall within the real video duration; errors use explicit `COMPOSE_*` codes. Card texts are not logged.
