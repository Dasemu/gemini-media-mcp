import "dotenv/config";
import { timingSafeEqual } from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { JobManager } from "./jobs.js";
import { audit, auditError } from "./log.js";
import { cleanupOrphanMedia, ensureMediaDir, mediaDir, migrateLegacyOutputs, resolvePublicOutput } from "./media.js";
import { publicMediaSigningConfigured, validatePublicMediaSignature } from "./public-media.js";
import { registerTools } from "./tools.js";

const jobs = new JobManager();
const retentionHours = Number(process.env.MEDIA_RETENTION_HOURS) || 168;
await ensureMediaDir();
const orphanCleanup = async () => {
  const removed = await cleanupOrphanMedia(retentionHours);
  if (removed > 0) audit("orphan_media_expired", { removed, retentionHours });
};
await orphanCleanup();
const migratedLegacyJobs = await migrateLegacyOutputs();
if (migratedLegacyJobs > 0) audit("legacy_outputs_migrated", { count: migratedLegacyJobs });
await jobs.restoreCompletedJobs();
jobs.startCleanup(retentionHours);
const orphanCleanupInterval = setInterval(() => void orphanCleanup().catch((error) => auditError("orphan_media_cleanup_failed", error)), 15 * 60 * 1000);
orphanCleanupInterval.unref();

function buildServer(): McpServer {
  const server = new McpServer({ name: "zenvairo-google-media", version: "1.0.0" });
  registerTools(server, jobs);
  return server;
}

const app = express();
app.disable("x-powered-by");
app.use(express.json({ limit: `${Number(process.env.MAX_MCP_REQUEST_MB) || 40}mb` }));

app.get("/public-media/:filename", async (req, res) => {
  const started = Date.now();
  const validation = validatePublicMediaSignature(req.params.filename, req.query.expires, req.query.signature);
  if (!validation.valid) {
    const status = validation.reason === "expired" ? 410 : 403;
    res.setHeader("Cache-Control", "private, no-store");
    res.status(status).json({ error: validation.reason === "expired" ? "url_expired" : "invalid_signature" });
    return;
  }
  const output = await resolvePublicOutput(req.params.filename);
  if (!output) {
    res.setHeader("Cache-Control", "private, no-store");
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Content-Type", output.mimeType);
  res.setHeader("Content-Length", String(output.sizeBytes));
  res.setHeader("X-Content-Type-Options", "nosniff");
  return res.sendFile(output.filename, { root: mediaDir, dotfiles: "deny", maxAge: 0 }, (error) => {
    if (error && !res.headersSent) res.status((error as Error & { statusCode?: number }).statusCode || 404).json({ error: "not_found" });
    audit("public_media_download", { filename: output.filename, sizeBytes: output.sizeBytes, durationMs: Date.now() - started, success: !error });
  });
});

app.use(authenticate);

app.get("/health", (_req, res) => res.json({ ok: true, service: "zenvairo-google-media", googleCredentialsConfigured: Boolean(process.env.GEMINI_API_KEY), publicMediaSigningConfigured: publicMediaSigningConfigured() }));
app.get("/media/:filename", (req, res) => {
  if (!/^[0-9a-f-]{36}-\d+\.(png|jpg|mp4)$/.test(req.params.filename)) return res.status(404).json({ error: "not_found" });
  return res.sendFile(req.params.filename, { root: mediaDir, dotfiles: "deny", maxAge: 0 }, (error) => {
    if (error && !res.headersSent) res.status((error as Error & { statusCode?: number }).statusCode || 404).json({ error: "not_found" });
  });
});

app.post("/mcp", async (req, res) => {
  const started = Date.now();
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
    audit("mcp_request", { method: req.body?.method, durationMs: Date.now() - started, statusCode: res.statusCode });
  } catch (error) {
    auditError("mcp_request_failed", error, { method: req.body?.method, durationMs: Date.now() - started });
    if (!res.headersSent) res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: req.body?.id ?? null });
  }
});
app.get("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed; this stateless Streamable HTTP server accepts POST /mcp." }));
app.delete("/mcp", (_req, res) => res.status(405).json({ error: "Method not allowed; this stateless Streamable HTTP server accepts POST /mcp." }));

const port = Number(process.env.PORT) || 8087;
const host = process.env.HOST || "127.0.0.1";
app.listen(port, host, () => audit("server_started", { host, port, endpoint: "/mcp", mediaRetentionHours: retentionHours }));

function authenticate(req: express.Request, res: express.Response, next: express.NextFunction): void {
  const required = process.env.MCP_SERVER_TOKEN;
  if (!required) {
    res.status(503).json({ error: "server_not_configured", message: "MCP_SERVER_TOKEN is required" });
    return;
  }
  const authorization = req.get("authorization") || "";
  const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
  const injected = req.get("x-mcp-server-token") || "";
  if (!safeEqual(required, bearer) && !safeEqual(required, injected)) {
    res.setHeader("WWW-Authenticate", "Bearer");
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  next();
}

function safeEqual(expected: string, actual: string): boolean {
  const a = Buffer.from(expected); const b = Buffer.from(actual);
  return a.length === b.length && timingSafeEqual(a, b);
}
