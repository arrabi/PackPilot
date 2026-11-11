# Configure an independent instance

The architecture is Supabase Cloud, Cloudflare Pages, Google OAuth and Brevo. Values in config/instance.example.json are safe placeholders, not working services. The internal pack99_* and PACK99_* names remain unchanged for compatibility.

Before applying migrations to a NEW empty instance, copy config/instance.example.json to ignored .local/instance.json and fill in your own project refs, origins, Pages names, account ID, repository owner/name, contact/admin/test emails, registration links, guide and parent-skills survey. Do not put passwords or tokens in this file.

```bash
python scripts/configure-instance.py .local/instance.json
python scripts/configure-instance.py .local/instance.json --apply
```

The first command previews the number of replacements. The second replaces template metadata across this private instance checkout and records a local stamp. It is an offline, one-time configuration step, not a provider installer. Do it before the first schema deployment; never rewrite applied migration SQL. Treat a configured instance checkout as private.

Create ignored auth-ui/.env.production or set these public build variables on the deployment runner:

- VITE_SUPABASE_URL: your environment's Supabase HTTPS URL.
- VITE_SUPABASE_PUBLISHABLE_KEY: that same environment's browser publishable key.

The backend's SUPABASE_URL and platform keys are injected by Supabase. Configure AUTH_UI_ORIGIN, PACK99_ENVIRONMENT and MCP_RESOURCE_URL for the exact matching environment; the source keeps strict project/origin matching. All privileged keys belong in ignored local files or provider/GitHub secret stores.

Notifications still use BREVO_API_KEY, PACK99_DATABASE_KEY, PACK99_FROM_EMAIL and PACK99_DISPATCH_SECRET. PACK99_DELIVERY_PAUSED=true prevents sending. Set PACK99_AUTH_UI_ORIGIN to the matching website origin as well. For staging, PACK99_EMAIL_ALLOWLIST permits only the configured owned test inbox. Keep equivalent isolation for Auth-generated email.

Operational backup/rehearsal utilities need PRODUCTION_DATABASE_URL with verified TLS, PRODUCTION_SUPABASE_SERVICE_KEY, R2_ENDPOINT, R2_ACCESS_KEY_ID and R2_SECRET_ACCESS_KEY, plus the Cloudflare account ID. Use a private Standard bucket with public access disabled. Never paste secret values into chat, source, issue text or ordinary Actions artifacts.

Optional in-app Ask AI additionally uses server-only `OPENAI_API_KEY` and optional `OPENAI_MODEL` in each intended Supabase environment. See [the assistant guide](fieldbook-assistant.md). Do not place provider keys in instance.example.json or browser build variables.
