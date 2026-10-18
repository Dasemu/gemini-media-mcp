# API y credenciales de Google

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

## Encadenar imágenes de referencia

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

## Componer tarjetas sobre un vídeo

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
