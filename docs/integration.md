# Claude.ai / Cowork

1. In Claude.ai, open **Settings -> Connectors -> Add custom connector**.
2. Use the HTTPS URL provided at the end of the deployment, which already embeds the HTTP Basic username and password.
3. Enable the connector tools in Cowork.
4. Call `who_am_i` first; then submit with `generate_*` and poll the UUID with `query_tasks` until a terminal state.

For video, expect between 11 seconds and 6 minutes according to the official documentation. Avoid aggressive polling; 10-15 seconds is reasonable.
