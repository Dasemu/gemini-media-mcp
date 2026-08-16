import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

test("real MCP generate_image -> query_tasks returns a decodable image", { timeout: 240_000 }, async (t) => {
  if (!process.env.GEMINI_API_KEY || !process.env.MCP_SERVER_TOKEN) {
    t.skip("Set GEMINI_API_KEY and MCP_SERVER_TOKEN to run the paid real integration test");
    return;
  }
  const endpoint = new URL(process.env.MCP_TEST_URL || "http://127.0.0.1:8087/mcp");
  const transport = new StreamableHTTPClientTransport(endpoint, { requestInit: { headers: { Authorization: `Bearer ${process.env.MCP_SERVER_TOKEN}` } } });
  const client = new Client({ name: "gemini-veo-real-integration", version: "1.0.0" });
  await client.connect(transport);
  try {
    const submitted = parseText(await client.callTool({ name: "generate_image", arguments: {
      model: "gemini-2.5-flash-image",
      arguments: [{ name: "prompt", value: "A minimal flat vector blue circle centered on a white background. No text." }, { name: "resolution", value: "1K" }, { name: "aspect_ratio", value: "1:1" }, { name: "image_count", value: 1 }],
    } }));
    assert.equal(submitted.status, "QUEUING");
    assert.match(String(submitted.generationId), /^[0-9a-f-]{36}$/);

    let completed: any;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const polled = parseText(await client.callTool({ name: "query_tasks", arguments: { generationId: submitted.generationId, include_base64: true } }));
      if (polled.status === "FAILED") assert.fail(`Generation failed: ${JSON.stringify(polled.error)}`);
      if (polled.status === "COMPLETED") { completed = polled; break; }
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    assert.ok(completed, "generation did not complete within 180 seconds");
    assert.equal(completed.outputs.length, 1);
    assert.ok(completed.outputs[0].base64, "expected inline base64 output");
    const image = Buffer.from(completed.outputs[0].base64, "base64");
    const isPng = image.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isJpeg = image[0] === 0xff && image[1] === 0xd8 && image[2] === 0xff;
    assert.ok(isPng || isJpeg, "decoded base64 is not a valid PNG/JPEG image");
  } finally {
    await client.close();
  }
});

function parseText(result: any): any {
  const text = result.content?.find((item: any) => item.type === "text")?.text;
  assert.ok(text, "tool result did not contain JSON text");
  return JSON.parse(text);
}
