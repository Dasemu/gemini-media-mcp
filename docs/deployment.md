# Deployment on LXC 210 (Alpine/OpenRC)

The operational install lives in `/opt/gemini-veo-mcp`, runs as `mcp:mcp`, binds to `127.0.0.1:8087` and is supervised by OpenRC (`gemini-veo-mcp`). nginx protects `/media-mcp/` with Basic auth and leaves only `/media-mcp/public-media/` public; the application requires a valid, expiring HMAC signature on that route.

To add the API key:

```sh
pct exec 210 -- vi /opt/gemini-veo-mcp/gemini-veo-mcp.env
pct exec 210 -- rc-service gemini-veo-mcp restart
```

Checks:

```sh
pct exec 210 -- rc-service gemini-veo-mcp status
pct exec 210 -- tail -f /var/log/gemini-veo-mcp.log
```

Logs are JSON Lines and include model, UUID, duration, output bytes, estimated cost and retries; they do not include prompts or credentials.

Reference for the deployment files in `deploy/`:

- `gemini-veo-mcp.openrc`: OpenRC service.
- `gemini-veo-mcp.env.template`: environment variable template (no real secrets).
- `nginx-location.conf`: nginx configuration.

## Paid integration test

The test uses the full MCP: `generate_image` -> `query_tasks` until `COMPLETED`, decodes base64 and validates the PNG/JPEG signature. After configuring the key and restarting:

```sh
pct exec 210 -- /bin/sh -lc 'cd /opt/gemini-veo-mcp && set -a && . ./gemini-veo-mcp.env && set +a && npm run test:integration'
```

Without credentials the test is marked `SKIP` and incurs no cost.
