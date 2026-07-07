# Deployment guide (roadmap → done)

> Reference deployment. Adapt to your platform. **Always terminate TLS in front of the server.**

## 1. Environment
Copy `.env.example` → set real values. In production the OAuth issuer is your real IdP (WorkOS/Auth0/
Keycloak), not the dev stub.

Required: `RESOURCE_URL`, `OAUTH_ISSUER`, `OAUTH_JWKS_URI`, `OAUTH_AUDIENCE`.

## 2. Container
```bash
docker build -t mcp-showcase-server .
docker run --rm -p 8970:8970 --env-file .env mcp-showcase-server
```
The image runs as non-root and installs prod deps only.

## 3. TLS (mandatory)
The server speaks plain HTTP; put a TLS-terminating reverse proxy in front (Caddy/nginx/Traefik or your
cloud LB). Example Caddy:
```
mcp.example.com {
    reverse_proxy 127.0.0.1:8970
}
```
Set `RESOURCE_URL=https://mcp.example.com` and `OAUTH_AUDIENCE` accordingly so token `aud` matches.

## 4. Postgres store with Row-Level-Security
```bash
# 1. apply the migration as an admin role
psql "$ADMIN_DATABASE_URL" -f migrations/001_notes_rls.sql

# 2. create a least-privilege app role (see comments in the migration)
psql "$ADMIN_DATABASE_URL" -c "CREATE ROLE mcp_app LOGIN PASSWORD '...'; GRANT SELECT, INSERT ON notes TO mcp_app;"

# 3. run the server against it
STORE=pg DATABASE_URL="postgres://mcp_app:...@host:5432/db" npm install pg && node dist/index.js
```
RLS enforces tenant isolation **at the database**, even if application code forgets a `WHERE tenant` clause.
The app additionally sets `app.current_tenant` per transaction and filters explicitly (defense in depth).

> With **Supabase**: RLS is native. Create the `notes` table + policy from the migration, connect via the
> session pooler, and set `app.current_tenant` per request. The MCP connection tools for Supabase can create
> the table/policy directly.

## 5. Downstream calls — no token passthrough
For calls to downstream APIs on behalf of the user, use **token exchange** (`src/token-exchange.ts`, RFC 8693)
against an IdP that supports it — never forward the incoming user token. See the "confused deputy" article.

## 6. Operational
- Ship the audit log (`AUDIT_LOG_PATH`) to your log store; it's append-only JSON Lines with secrets redacted.
- Tune `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` per tenant SLA.
- Run `mcp-sec-scan https://mcp.example.com/mcp --token <test-token> --active` after each deploy (or wire the
  GitHub Action) — behind TLS the scan should be clean.
