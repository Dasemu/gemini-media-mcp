# Entrega de medios y límites

`query_tasks` usa `include_base64=false` por defecto para que los binarios no entren accidentalmente en el contexto del LLM. Cada output devuelve `index`, `mimeType`, `sizeBytes`, `sha256`, el `downloadUrl` protegido anterior y una `publicUrl` firmada que Meta puede descargar sin credenciales. El base64 continúa disponible de forma explícita con `include_base64=true` cuando el tamaño binario agregado del job es como máximo **25 MiB exactos (26.214.400 bytes)**.

`publicUrl` usa el mismo dominio bajo `/zenvairogoogle/public-media/...`, lleva una firma HMAC ligada al nombre y caducidad, y dura 24 horas por defecto (`PUBLIC_MEDIA_URL_TTL_SECONDS=86400`). La ruta no acepta Basic ni Bearer porque Meta debe leerla directamente; sin firma válida responde 403 y una firma caducada responde 410. Cada llamada posterior a `query_tasks` emite una URL nueva mientras el resultado siga retenido.

El `downloadUrl` anterior bajo `/zenvairogoogle/media/...` continúa protegido por las credenciales HTTP Basic del conector. Nunca se devuelve una URL de Google, GCS o un CDN tercero. La clave HMAC (`PUBLIC_MEDIA_SIGNING_SECRET`, mínimo 32 caracteres) solo existe en el servidor y no aparece en schemas, logs o respuestas.

Para publicar sin copiar ni mover base64, pasa `outputs[].publicUrl` directamente a `publish_post` de SocialMCP como `imageUrl`, `videoUrl` o `media[].url`. No llames antes a `upload_media`.

Los resultados completados se guardan en disco, indexados por `generationId`, con bytes, MIME, SHA-256 e índice en un manifiesto atómico. Se restauran después de reiniciar el servicio y se conservan **7 días (168 horas)** por defecto mediante `MEDIA_RETENTION_HOURS`. Una tarea limpia archivos y manifiestos cada 15 minutos; conserva tombstones pequeños durante 30 días para distinguir IDs purgados de IDs inexistentes. Los jobs todavía pendientes siguen siendo memoria volátil.

Un artefacto individual mayor de 300 MiB se rechaza para proteger el disco del LXC. No hay reintentos silenciosos de moderación o validación; solo hasta 2 reintentos (3 intentos totales), registrados en log, para 429, 5xx y fallos transitorios de red.
