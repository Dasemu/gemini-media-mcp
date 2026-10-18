# Zenvairo Google Media MCP

Servidor MCP remoto y *stateless* (Streamable HTTP) para generación de imágenes con Gemini y vídeo con Veo 3.1. Sigue el contrato `submit + poll`: `generate_image`/`generate_video` devuelven inmediatamente un UUID y `query_tasks` entrega el resultado final.

## Quick start

```sh
npm ci
cp .env.example .env   # rellena GEMINI_API_KEY y los demás valores
npm run dev            # o: npm run build && npm start
```

Tools disponibles: `who_am_i`, `generate_image`, `generate_video`, `compose_video_overlay`, `query_tasks`, `get_usage`.

## Documentación

- [`docs/api.md`](docs/api.md) — credenciales de Google, tools, referencias de imagen y composición de overlays.
- [`docs/media-delivery.md`](docs/media-delivery.md) — entrega de medios, límites y retención.
- [`docs/deployment.md`](docs/deployment.md) — despliegue en LXC 210 (Alpine/OpenRC) y test de integración pagado.
- [`docs/integration.md`](docs/integration.md) — alta como conector en Claude.ai / Cowork.
- [`CLAUDE.md`](CLAUDE.md) — comandos, arquitectura y convenciones para desarrollo.
