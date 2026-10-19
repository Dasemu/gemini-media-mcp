# Gemini Veo Media MCP

Remote, stateless (Streamable HTTP) MCP server for image generation with Gemini and video generation with Veo 3.1. It follows the `submit + poll` contract: `generate_image`/`generate_video` return a UUID immediately and `query_tasks` delivers the final result.

## Quick start

```sh
npm ci
cp .env.example .env   # fill in GEMINI_API_KEY and the other values
npm run dev            # or: npm run build && npm start
```

Available tools: `who_am_i`, `generate_image`, `generate_video`, `compose_video_overlay`, `query_tasks`, `get_usage`.

## Documentation

- [`docs/api.md`](docs/api.md) - Google credentials, tools, image references and overlay composition.
- [`docs/media-delivery.md`](docs/media-delivery.md) - media delivery, limits and retention.
- [`docs/deployment.md`](docs/deployment.md) - deployment on LXC 210 (Alpine/OpenRC) and the paid integration test.
- [`docs/integration.md`](docs/integration.md) - registering the server as a Claude.ai / Cowork connector.
- [`CLAUDE.md`](CLAUDE.md) - commands, architecture and conventions for development.
