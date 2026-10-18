# Despliegue LXC 210 (Alpine/OpenRC)

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

Referencia de los ficheros de despliegue en `deploy/`:

- `gemini-veo-mcp.openrc`: servicio OpenRC.
- `gemini-veo-mcp.env.template`: plantilla de variables de entorno (sin secretos reales).
- `default.conf.lxc210`, `nginx-location.conf`: configuración de nginx.

## Test real pagado

El test usa el MCP completo: `generate_image` → `query_tasks` hasta `COMPLETED`, decodifica base64 y valida la firma PNG/JPEG. Tras configurar la key y reiniciar:

```sh
pct exec 210 -- /bin/sh -lc 'cd /opt/gemini-veo-mcp && set -a && . ./gemini-veo-mcp.env && set +a && npm run test:integration'
```

Sin credenciales el test se marca como `SKIP` y no incurre en coste.
