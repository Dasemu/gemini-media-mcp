# Claude.ai / Cowork

1. En Claude.ai, abre **Settings → Connectors → Add custom connector**.
2. Usa la URL HTTPS proporcionada al finalizar el despliegue, que ya incorpora el usuario y contraseña HTTP Basic.
3. Activa las tools del conector en Cowork.
4. Llama primero a `who_am_i`; después envía con `generate_*` y consulta el UUID con `query_tasks` hasta estado terminal.

Para vídeo, espera entre 11 segundos y 6 minutos según la documentación oficial. Evita polling agresivo; 10–15 segundos es razonable.
