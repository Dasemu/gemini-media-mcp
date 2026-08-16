import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("real Veo generation -> local overlay composition -> signed public URL", { timeout: 900_000 }, async (t) => {
  if (!process.env.GEMINI_API_KEY || !process.env.MCP_SERVER_TOKEN) {
    t.skip("Set GEMINI_API_KEY and MCP_SERVER_TOKEN to run the paid real integration test");
    return;
  }
  const endpoint = new URL(process.env.MCP_TEST_URL || "http://127.0.0.1:8087/mcp");
  const transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_SERVER_TOKEN}` } },
  });
  const client = new Client({ name: "gemini-veo-compose-integration", version: "1.0.0" });
  const taskTraceId = randomUUID();
  await client.connect(transport);
  try {
    const submitted = parseText(await client.callTool({ name: "generate_video", arguments: {
      model: "veo-3.1-lite",
      taskTraceId,
      arguments: [
        { name: "prompt", value: "Vertical cinematic brand clip of abstract digital infrastructure, dark navy surfaces with cyan light trails, smooth slow camera motion, subtle electronic ambience, no text, no logos, keep the lower-center area visually uncluttered." },
        { name: "resolution", value: "720p" },
        { name: "aspect_ratio", value: "9:16" },
        { name: "duration_seconds", value: 8 },
        { name: "with_audio", value: true },
      ],
    } }));
    assert.equal(submitted.status, "QUEUING");
    const base = await poll(client, submitted.generationId, taskTraceId, 40, 15_000);
    assert.equal(base.type, "video");
    assert.equal(base.outputs[0].base64, undefined);

    const composedSubmission = parseText(await client.callTool({ name: "compose_video_overlay", arguments: {
      base_generation_id: submitted.generationId,
      taskTraceId,
      overlays: [
        { kicker: "ZENVAIRO", text: "La automatización no debería sentirse genérica", style: "normal", start_time: 0.6, duration: 2.5 },
        { kicker: "ACTÚA AHORA", text: "Convierte procesos en ventaja", style: "cta", start_time: 4.8, duration: 2.5 },
      ],
    } }));
    assert.equal(composedSubmission.status, "QUEUING");
    const composed = await poll(client, composedSubmission.generationId, taskTraceId, 90, 2_000);
    assert.equal(composed.model, "ffmpeg-overlay");
    assert.equal(composed.outputs[0].mimeType, "video/mp4");
    assert.equal(composed.outputs[0].base64, undefined);
    assert.match(composed.outputs[0].publicUrl, /^https:\/\/mcp\.zenvairo\.es\/zenvairogoogle\/public-media\//);

    const publicResponse = await fetch(composed.outputs[0].publicUrl);
    assert.equal(publicResponse.status, 200);
    const video = Buffer.from(await publicResponse.arrayBuffer());
    assert.equal(video.length, composed.outputs[0].sizeBytes);
    assert.equal(video.subarray(4, 8).toString("ascii"), "ftyp");
    console.log(JSON.stringify({
      baseGenerationId: submitted.generationId,
      composedGenerationId: composedSubmission.generationId,
      composedSizeBytes: video.length,
      publicUrl: composed.outputs[0].publicUrl,
      publicUrlExpiresAt: composed.outputs[0].publicUrlExpiresAt,
    }));
  } finally {
    await client.close();
  }
});

async function poll(client: Client, generationId: string, taskTraceId: string, attempts: number, intervalMs: number): Promise<any> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = parseText(await client.callTool({ name: "query_tasks", arguments: { generationId, taskTraceId, include_base64: false } }));
    console.log(JSON.stringify({ generationId, attempt, status: result.status }));
    if (result.status === "FAILED") assert.fail(`Job failed: ${JSON.stringify(result.error)}`);
    if (result.status === "COMPLETED") return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  assert.fail(`Job ${generationId} did not complete in time`);
}

function parseText(result: any): any {
  const text = result.content?.find((item: any) => item.type === "text")?.text;
  assert.ok(text, "tool result did not contain JSON text");
  return JSON.parse(text);
}
