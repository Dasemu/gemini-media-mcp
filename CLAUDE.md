# CLAUDE.md

## Overview
Remote, stateless Streamable HTTP MCP server exposing Google Gemini image generation and Veo 3.1 video generation, plus local video-overlay composition. Follows a submit+poll contract: `generate_image`/`generate_video` return a UUID immediately, `query_tasks` returns the final result.

## Commands
- Install: `npm ci`
- Dev: `npm run dev` (tsx, no build step)
- Build: `npm run build` (tsc -> `dist/`)
- Start (built): `npm start`
- Unit tests: `npm test` (requires `PUBLIC_MEDIA_SIGNING_SECRET` >= 32 chars in the environment — see LESSONS.md)
- Paid integration tests (real Gemini/Veo calls, require `GEMINI_API_KEY`): `npm run test:integration`, `npm run test:integration:compose`
- No linter/formatter is configured; `npm run build` (`tsc --strict`) is the only static check.

## Architecture
MCP tool handlers in `src/tools.ts` dispatch to `src/provider.ts` (Gemini/Veo API calls) and `src/compositor.ts` (ffmpeg/Pillow overlay composition via `scripts/make_overlay_card.py`). `src/jobs.ts` tracks in-memory job state for the submit+poll pattern; `src/media.ts` persists completed outputs to disk (`MEDIA_DIR`) with a manifest, and `src/public-media.ts` signs time-limited public download URLs (HMAC). `src/catalog.ts` and `src/arguments.ts` define/validate the model catalog and tool arguments. Entry point: `src/index.ts` (Express + MCP SDK). Details: `docs/`.

## Conventions
- TypeScript, ESM (`"type": "module"`), strict mode, Node >= 20.
- Secrets (API keys, signing secret, HTTP Basic credentials) are never logged, never part of MCP schemas/responses.
- Prompts, reference-image bytes and overlay card text are never written to logs.

## Workflow quirks
- `.env` / `deploy/gemini-veo-mcp.env` / `deploy/*.htpasswd` / `deploy/.*-password` are untracked (see `.gitignore`) and deploy-specific; `.env.example` and `deploy/gemini-veo-mcp.env.template` list variable names only.
- No `development` branch exists yet; branch from `main` until one is created.

## Deployment
Deployed to an Alpine LXC container (OpenRC service `gemini-veo-mcp`, bound to `127.0.0.1:8087`, nginx reverse-proxying `/zenvairogoogle/`). See `README.md` for the update/restart commands and `docs/deployment.md` for full details.

## Gotchas
- Veo 3.1 always generates audio; `with_audio=false` is rejected explicitly.
- `query_tasks` defaults to `include_base64=false`; base64 is only returned when the job's aggregate binary size is <= 25 MiB.
- A single media artifact over 300 MiB is rejected outright (`MAX_MEDIA_MB`).
