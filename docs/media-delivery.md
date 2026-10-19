# Media delivery and limits

`query_tasks` uses `include_base64=false` by default so binaries do not accidentally enter the LLM context. Each output returns `index`, `mimeType`, `sizeBytes`, `sha256`, the protected `downloadUrl` and a signed `publicUrl` that Meta can download without credentials. Base64 remains available explicitly with `include_base64=true` when the job's aggregate binary size is at most **25 MiB exactly (26,214,400 bytes)**.

`publicUrl` uses the same domain under `/media-mcp/public-media/...`, carries an HMAC signature bound to the file name and expiry, and lasts 24 hours by default (`PUBLIC_MEDIA_URL_TTL_SECONDS=86400`). The route accepts neither Basic nor Bearer because Meta must read it directly; without a valid signature it responds 403 and an expired signature responds 410. Each later `query_tasks` call issues a fresh URL while the result is still retained.

The `downloadUrl` under `/media-mcp/media/...` stays protected by the connector's HTTP Basic credentials. A Google, GCS or third-party CDN URL is never returned. The HMAC key (`PUBLIC_MEDIA_SIGNING_SECRET`, minimum 32 characters) exists only on the server and never appears in schemas, logs or responses.

To publish without copying or moving base64, pass `outputs[].publicUrl` directly to SocialMCP's `publish_post` as `imageUrl`, `videoUrl` or `media[].url`. Do not call `upload_media` first.

Completed results are stored on disk, indexed by `generationId`, with bytes, MIME type, SHA-256 and index in an atomic manifest. They are restored after a service restart and kept **7 days (168 hours)** by default via `MEDIA_RETENTION_HOURS`. A task cleans up files and manifests every 15 minutes; small tombstones are kept for 30 days to distinguish purged IDs from nonexistent ones. Jobs still pending remain volatile in-memory state.

A single artifact larger than 300 MiB is rejected to protect the LXC disk. There are no silent retries for moderation or validation failures; only up to 2 retries (3 attempts in total), logged, for 429, 5xx and transient network failures.
