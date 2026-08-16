# Zenvairo Google Media MCP

Servidor MCP remoto y *stateless* (Streamable HTTP) para generación de imágenes con Gemini y vídeo con Veo 3.1. Sigue el contrato `submit + poll`: `generate_image`/`generate_video` devuelven inmediatamente un UUID y `query_tasks` entrega el resultado final.

## API y credenciales de Google

A fecha de referencia **2026-08-14**, Veo 3.1 Standard, Fast y Lite están disponibles en la capa de pago de la **Gemini Developer API**. Por tanto, tanto imagen como vídeo usan únicamente `GEMINI_API_KEY`; no se requieren `GOOGLE_APPLICATION_CREDENTIALS`, `GCP_PROJECT_ID` ni `GCP_LOCATION` para los modelos expuestos aquí.

Fuentes oficiales:

- Imagen: https://ai.google.dev/gemini-api/docs/image-generation
- Veo: https://ai.google.dev/gemini-api/docs/veo
- Precios: https://ai.google.dev/gemini-api/docs/pricing

La clave nunca forma parte de los schemas o respuestas MCP. El proceso arranca sin clave para permitir `who_am_i` y health checks, pero los jobs fallarán con `SERVER_NOT_CONFIGURED` hasta configurarla.

## Tools

- `who_am_i`: catálogo por tipo, alias, argumentos, restricciones y precios oficiales de referencia.
- `generate_image`: envío no bloqueante de una o varias imágenes.
- `generate_video`: envío no bloqueante de un vídeo Veo.
- `compose_video_overlay`: composición local no bloqueante de tarjetas Pillow sobre un vídeo retenido, con un nuevo `generationId`.
- `query_tasks`: polling compartido y entrega final.
- `get_usage`: estimaciones acumuladas desde el último arranque. Google no expone el saldo restante de facturación mediante esta API.

`arguments` siempre es una lista `{ "name": ..., "value": ... }`, compatible con el patrón del conector Kling. Veo 3.1 siempre genera audio; `with_audio=false` se rechaza explícitamente.

### Encadenar imágenes de referencia

`generate_image` acepta `reference_images` con dos variantes mezclables. La recomendada referencia una generación terminada por UUID, de modo que los bytes viajan directamente del disco del servidor a Gemini y nunca pasan por el contexto del LLM:

```json
{
  "model": "gemini-3.1-flash-image",
  "arguments": [
    { "name": "prompt", "value": "Crea la slide 2 manteniendo exactamente el estilo visual de la referencia" },
    {
      "name": "reference_images",
      "value": [
        { "generation_id": "<generationId de la slide anterior>", "index": 0 }
      ]
    },
    { "name": "aspect_ratio", "value": "4:5" },
    { "name": "resolution", "value": "1K" }
  ]
}
```

La variante inline anterior sigue siendo compatible: `{ "base64": "...", "mime_type": "image/png" }`. Un mismo array puede mezclar referencias por ID e inline. Se admiten PNG, JPEG y WebP, hasta 20 MiB por referencia inline y 25 MiB agregados por request. Los límites de cantidad son 3 referencias para Gemini 2.5 Flash Image y 14 para los modelos Gemini 3 expuestos. Las referencias nunca se escriben en logs.

Las referencias por ID producen códigos claros: `REFERENCE_GENERATION_NOT_FOUND`, `REFERENCE_GENERATION_NOT_COMPLETED`, `REFERENCE_INDEX_OUT_OF_RANGE`, `REFERENCE_GENERATION_EXPIRED` y `REFERENCE_IS_VIDEO`.

### Componer tarjetas sobre un vídeo

`compose_video_overlay` recibe el `generationId` de un vídeo vertical 9:16 ya `COMPLETED` y entre 1 y 10 tarjetas temporizadas. Devuelve inmediatamente un `generationId` nuevo; el trabajo se realiza localmente con Pillow, Poppins Bold y ffmpeg, conserva el audio original y se consulta con el mismo `query_tasks`:

```json
{
  "base_generation_id": "<generationId del video Veo>",
  "overlays": [
    { "kicker": "GANCHO", "text": "Tu equipo no necesita más herramientas", "style": "normal", "start_time": 0.6, "duration": 2.5 },
    { "kicker": "SIGUIENTE PASO", "text": "Automatiza lo repetitivo", "style": "cta", "start_time": 4.8, "duration": 2.5 }
  ]
}
```

El vídeo base no se descarga ni regenera: sus bytes pasan del almacén retenido al proceso ffmpeg. El resultado se persiste como otra generación `video/mp4`, con tamaño y SHA-256 reales, retención normal y las mismas `downloadUrl`/`publicUrl`. Los timings deben quedar dentro de la duración real del vídeo; los errores usan códigos `COMPOSE_*` explícitos. Los textos de las tarjetas no se registran en logs.

## Entrega de medios y límites

`query_tasks` usa `include_base64=false` por defecto para que los binarios no entren accidentalmente en el contexto del LLM. Cada output devuelve `index`, `mimeType`, `sizeBytes`, `sha256`, el `downloadUrl` protegido anterior y una `publicUrl` firmada que Meta puede descargar sin credenciales. El base64 continúa disponible de forma explícita con `include_base64=true` cuando el tamaño binario agregado del job es como máximo **25 MiB exactos (26.214.400 bytes)**.

`publicUrl` usa el mismo dominio bajo `/zenvairogoogle/public-media/...`, lleva una firma HMAC ligada al nombre y caducidad, y dura 24 horas por defecto (`PUBLIC_MEDIA_URL_TTL_SECONDS=86400`). La ruta no acepta Basic ni Bearer porque Meta debe leerla directamente; sin firma válida responde 403 y una firma caducada responde 410. Cada llamada posterior a `query_tasks` emite una URL nueva mientras el resultado siga retenido.

El `downloadUrl` anterior bajo `/zenvairogoogle/media/...` continúa protegido por las credenciales HTTP Basic del conector. Nunca se devuelve una URL de Google, GCS o un CDN tercero. La clave HMAC (`PUBLIC_MEDIA_SIGNING_SECRET`, mínimo 32 caracteres) solo existe en el servidor y no aparece en schemas, logs o respuestas.

Para publicar sin copiar ni mover base64, pasa `outputs[].publicUrl` directamente a `publish_post` de SocialMCP como `imageUrl`, `videoUrl` o `media[].url`. No llames antes a `upload_media`.

Los resultados completados se guardan en disco, indexados por `generationId`, con bytes, MIME, SHA-256 e índice en un manifiesto atómico. Se restauran después de reiniciar el servicio y se conservan **7 días (168 horas)** por defecto mediante `MEDIA_RETENTION_HOURS`. Una tarea limpia archivos y manifiestos cada 15 minutos; conserva tombstones pequeños durante 30 días para distinguir IDs purgados de IDs inexistentes. Los jobs todavía pendientes siguen siendo memoria volátil.

Un artefacto individual mayor de 300 MiB se rechaza para proteger el disco del LXC. No hay reintentos silenciosos de moderación o validación; solo hasta 2 reintentos (3 intentos totales), registrados en log, para 429, 5xx y fallos transitorios de red.

## Despliegue LXC 210 (Alpine/OpenRC)

La instalación operativa está en `/opt/gemini-veo-mcp`, ejecutada como `mcp:mcp`, ligada a `127.0.0.1:8087` y supervisada por OpenRC (`gemini-veo-mcp`). nginx protege `/zenvairogoogle/` con Basic y deja pública únicamente `/zenvairogoogle/public-media/`; la aplicación exige en esa ruta una firma HMAC válida y caducable.

Para añadir la API key:

```sh
pct exec 210 -- vi /opt/gemini-veo-mcp/gemini-veo-mcp.env
pct exec 210 -- rc-service gemini-veo-mcp restart
```

Comprobaciones:

```sh
pct exec 210 -- rc-service gemini-veo-mcp status
pct exec 210 -- tail -f /var/log/gemini-veo-mcp.log
```

Los logs son JSON Lines e incluyen modelo, UUID, duración, bytes de salida, coste estimado y reintentos; no incluyen prompts ni credenciales.

## Test real pagado

El test usa el MCP completo: `generate_image` → `query_tasks` hasta `COMPLETED`, decodifica base64 y valida la firma PNG/JPEG. Tras configurar la key y reiniciar:

```sh
pct exec 210 -- /bin/sh -lc 'cd /opt/gemini-veo-mcp && set -a && . ./gemini-veo-mcp.env && set +a && npm run test:integration'
```

Sin credenciales el test se marca como `SKIP` y no incurre en coste.

## Claude.ai / Cowork

1. En Claude.ai, abre **Settings → Connectors → Add custom connector**.
2. Usa la URL HTTPS proporcionada al finalizar el despliegue, que ya incorpora el usuario y contraseña HTTP Basic.
3. Activa las tools del conector en Cowork.
4. Llama primero a `who_am_i`; después envía con `generate_*` y consulta el UUID con `query_tasks` hasta estado terminal.

Para vídeo, espera entre 11 segundos y 6 minutos según la documentación oficial. Evita polling agresivo; 10–15 segundos es razonable.
