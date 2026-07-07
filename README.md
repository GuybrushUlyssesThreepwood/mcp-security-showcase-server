# mcp-showcase-server

**A reference MCP server that does the security layer right.**

While [`mcp-sec-scan`](../mcp-sec-scan) shows *"I find the mistakes"*, this shows *"I build it correctly."*
It's a production-shaped Model Context Protocol server (Streamable HTTP) with the four things SaaS teams
actually need before letting AI agents into their product:

- 🔐 **OAuth 2.1 resource server** — validates bearer JWTs against the IdP's JWKS (signature, issuer, audience, expiry). PKCE/S256 advertised by the authorization server.
- 🧱 **Strict tenant isolation** — the tenant is read **only** from the verified token, never from a request parameter. Every store operation is tenant-scoped. Cross-tenant access returns *"not found"* (no existence leak).
- 📒 **Structured audit log** — append-only JSON Lines: who · tenant · tool · params (redacted) · outcome · time.
- 🚦 **Per-tenant rate limiting** — fixed-window limiter, `429 + Retry-After`, protects against agent loops / cost blowups.
- 🧯 Least-privilege **scopes** per tool, generic error responses (no stack-trace/secret leakage), restrictive CORS.

> The HTTP/security layer is written explicitly (not hidden in a framework) on purpose — it *is* the product.
> A real domain API and a real IdP slot in behind the same interfaces (see [`docs/api-auswahl.md`](docs/api-auswahl.md)).

---

## Run it locally (2 terminals)

```bash
npm install
npm run build

# terminal 1 — dev OAuth issuer (RS256 JWKS + AS metadata with PKCE S256)
npm run issuer

# terminal 2 — the MCP server
npm start
```

Mint a token and call it:

```bash
TOKEN=$(node scripts/dev-issuer.mjs mint acme notes:read,notes:write)

curl -s -X POST http://127.0.0.1:8970/mcp \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Without a token you get `401` + a `WWW-Authenticate` header pointing at the resource metadata.

## Prove the isolation

A `globex` token cannot read an `acme` note — same id, different tenant → `Note not found`:

```bash
ACME=$(node scripts/dev-issuer.mjs mint acme notes:read,notes:write)
GLOBEX=$(node scripts/dev-issuer.mjs mint globex notes:read,notes:write)
# create as acme, then try to read as globex using the returned id → not found
```

## Dogfooding

Run our own scanner against it:

```bash
node ../mcp-sec-scan/dist/cli.js http://127.0.0.1:8970/mcp --token "$ACME" --active
```

Result: auth enforced ✅, no unauth tools ✅, PKCE S256 ✅, no tool poisoning ✅, restrictive CORS ✅,
no error leakage ✅. The only local finding is **TLS** (because localhost runs over HTTP) — in production
behind HTTPS this passes. The rate-limit WARN is expected: an unauthenticated external scanner cannot
observe a *per-tenant* limit (it's enforced after auth).

## Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `list_notes` | `notes:read` | List the tenant's notes |
| `get_note` | `notes:read` | Get one note (tenant-scoped) |
| `create_note` | `notes:write` | Create a note for the tenant |

## Configuration (env)

| Var | Default | Meaning |
|-----|---------|---------|
| `PORT` | 8970 | Server port |
| `RESOURCE_URL` | `http://127.0.0.1:8970` | Public base URL / token audience |
| `OAUTH_ISSUER` | `http://127.0.0.1:8969` | IdP issuer |
| `OAUTH_JWKS_URI` | issuer `/.well-known/jwks.json` | JWKS endpoint |
| `TENANT_CLAIM` | `tenant` | Token claim carrying the tenant id |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 60 / 60000 | Per-tenant limit |
| `AUDIT_LOG_PATH` | `audit.log.jsonl` | Audit log file |

## Launch scope (T-103) & roadmap

Shipped for the 10 Aug launch: real tools + OAuth 2.1/PKCE validation + tenant isolation + audit log +
rate limiting. Roadmap (public, doubles as content per T-203):

- [x] Swap in-memory store for Postgres with Row-Level-Security — `STORE=pg` + `src/store-pg.ts` + `migrations/001_notes_rls.sql`
- [x] Token-exchange for downstream API calls (no passthrough) — `src/token-exchange.ts` (RFC 8693)
- [x] Deploy guide (container + reverse proxy TLS) — `Dockerfile` + `docs/deploy.md`
- [ ] Replace dev issuer with a real IdP integration (WorkOS/Auth0/Keycloak) — needs your IdP account
- [ ] Becomes the seed of the licensed Starter-Kit (T-801/T-802)

### Store backends
```bash
# default: in-memory (demo seeds)
npm start
# Postgres with RLS:
psql "$ADMIN_URL" -f migrations/001_notes_rls.sql
STORE=pg DATABASE_URL="postgres://mcp_app:...@host/db" npm install pg && npm start
```
See [docs/deploy.md](docs/deploy.md).

## ⚠️ Note

Uses a **dev-only** OAuth issuer stub for local testing. Do not use `scripts/dev-issuer.mjs` or
`.dev-keys.json` in production. Replace `[Your Name]` in `LICENSE` before publishing (T-105).

## License

Apache-2.0
