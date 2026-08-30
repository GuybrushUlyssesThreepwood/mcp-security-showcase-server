# mcp-showcase-server

**A reference MCP server that gets the security layer right.**

Where [`mcp-sec-scan`](https://github.com/GuybrushUlyssesThreepwood/mcp-security-sec-scan) says
*"I find the mistakes"*, this repo says *"I build it correctly."* It is a production-grade Model
Context Protocol server (Streamable HTTP) with the things SaaS teams actually need before they let
AI agents into their product:

- 🔐 **OAuth 2.1 resource server** — validates bearer JWTs against the IdP's JWKS (signature, issuer, audience, expiry). PKCE/S256 advertised by the authorization server.
- 🧱 **Strict tenant isolation** — the tenant is read **exclusively** from the verified token, never from a request parameter. Every store operation is tenant-bound. Cross-tenant access returns *"not found"* (no existence leak).
- 🌐 **Origin validation against DNS rebinding** — the MCP Streamable HTTP spec requires it. It is checked **before** auth: a valid token does not make a foreign origin acceptable, because what is at stake is where the request came from, not who sent it. Allow-list via `ALLOWED_ORIGINS`; clients without an Origin header (CLI, agent, server-to-server) pass.
- 📒 **Structured audit log** — append-only JSON Lines: who · tenant · tool · parameter **names** · outcome · time. **Deliberately without parameter values:** note contents do not belong in an audit log, or the log itself becomes the data-protection problem. If the log path is not writable, the server does not start.
- 🚦 **Per-tenant rate limiting** — fixed-window limiter, `429 + Retry-After`, guards against agent loops and cost explosions.
- 🧯 **Least-privilege scopes** per tool, generic error responses (no stack-trace or secret leaks), **no CORS headers** — access is purely token-based, and without `Access-Control-Allow-Origin` the browser blocks every cross-origin response.

> The HTTP/security layer is written out explicitly (not hidden inside a framework) — it *is* the
> product. A real domain API and a real IdP can be dropped in behind the same interfaces (see
> [`docs/swapping-the-domain.md`](docs/swapping-the-domain.md)).

---

## What is this?

**Why it exists.** The scanner proves "I find the mistakes" — that only becomes convincing with the
counterpart, "I build it correctly." This server is the living proof of competence: a reference
implementation of the security layer you can show, run against your own scanner (dogfooding), and
take as the starting point for customer projects.

**What it does.** A production-grade MCP server (Streamable HTTP) with an OAuth 2.1 resource server
(JWT validation against JWKS), strict tenant isolation (tenant from the token only, no cross-tenant
existence leak), origin validation, an append-only audit log, per-tenant rate limiting,
least-privilege scopes and generic error responses. Swappable store backends (in-memory / Postgres
with row-level security), token exchange (RFC 8693), Docker + deploy guide. 31 tests that back the
security promises.

**Who it is for.** SaaS teams and agencies that need to ship a remote MCP server safely before
letting AI agents into the product — as a template, a benchmark, or the basis of an audit.

## Run it locally (2 terminals)

```bash
npm install
npm run build

# Terminal 1 — dev OAuth issuer (RS256 JWKS + AS metadata with PKCE S256)
npm run issuer

# Terminal 2 — the MCP server
npm start
```

Mint a token and call it:

```bash
TOKEN=$(node scripts/dev-issuer.mjs mint acme notes:read,notes:write)

curl -s -X POST http://127.0.0.1:8970/mcp \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Without a token you get `401` plus a `WWW-Authenticate` header pointing at the resource metadata.

## Prove the tenant isolation

A `globex` token cannot read an `acme` note — same id, different tenant -> `Note not found`:

```bash
ACME=$(node scripts/dev-issuer.mjs mint acme notes:read,notes:write)
GLOBEX=$(node scripts/dev-issuer.mjs mint globex notes:read,notes:write)
# create as acme, then read as globex using the returned id -> not found
```

## Dogfooding

Run our own scanner against it:

```bash
node ../mcp-sec-scan/dist/cli.js http://127.0.0.1:8970/mcp --token "$ACME" --active
```

Result: auth enforced ✅, no unauthenticated tools ✅, PKCE S256 ✅, no tool poisoning ✅, no open
CORS ✅, no error leak ✅. The only local finding is **TLS** (because localhost runs over HTTP) — in
production behind HTTPS that check passes. The rate-limit WARN is expected: an unauthenticated
external scanner cannot observe a *per-tenant* limit (it applies only after auth).

The origin check reports `INFO` instead of `PASS`: from the outside the scanner only sees the 401 of
the auth layer and cannot tell whether an origin check sits behind it. It does — proven in
`test/server.test.ts`, not by scanner output.

## Tests

```bash
npm test
```

31 tests (`node:test`) that prove the security promises, not merely that the code compiles:

- **Auth** (`test/auth.test.ts`) — real RS256 JWT verification against a local JWKS server: a valid token yields tenant/scopes; a wrong **audience**, wrong **issuer**, an **expired** and a **signature-tampered** token are all rejected; a token **without a tenant claim** is refused (the tenant comes only from the token).
- **Tenant isolation** (`test/store.test.ts`, `test/tools.test.ts`) — a tenant sees only its own notes; a cross-tenant `get_note` with a real id returns *"not found"* (no existence leak).
- **Least privilege** (`test/tools.test.ts`) — every tool enforces its scope (`notes:read` / `notes:write`).
- **Rate limiting** (`test/ratelimit.test.ts`) — allowed up to `max`, then `429`; per tenant; the window resets.
- **Audit log** (`test/audit.test.ts`) — append-only JSON Lines; secret-bearing keys redacted; long params truncated.
- **HTTP layer** (`test/server.test.ts`) — a foreign `Origin` is refused with `403`, and **before** auth: a valid token does not get it through. An allow-listed origin passes, as does a missing origin. An oversized body returns `413`, not a fake parse error.

CI (`.github/workflows/ci.yml`) runs typecheck + tests + build, then starts the server and asserts
that an unauthenticated `tools/list` is refused with `401`.

## Tools

| Tool | Scope | Description |
|------|-------|-------------|
| `list_notes` | `notes:read` | List the tenant's notes |
| `get_note` | `notes:read` | Fetch one note (tenant-bound) |
| `create_note` | `notes:write` | Create a note for the tenant |

## Configuration (env)

| Variable | Default | Meaning |
|----------|---------|---------|
| `PORT` | 8970 | Server port |
| `RESOURCE_URL` | `http://127.0.0.1:8970` | Public base URL / token audience |
| `OAUTH_ISSUER` | `http://127.0.0.1:8969` | IdP issuer |
| `OAUTH_JWKS_URI` | issuer `/.well-known/jwks.json` | JWKS endpoint |
| `TENANT_CLAIM` | `tenant` | Token claim carrying the tenant id |
| `ALLOWED_ORIGINS` | *(empty)* | Comma-separated list of permitted `Origin` headers. Empty = every origin that is set is refused with `403`; requests without an origin pass |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 60 / 60000 | Limit per tenant |
| `AUDIT_LOG_PATH` | `audit.log.jsonl` | Audit log file. Not writable -> the server does not start |

> With `NODE_ENV=production`, `RESOURCE_URL`, `OAUTH_ISSUER`, `OAUTH_JWKS_URI` and `OAUTH_AUDIENCE`
> have **no defaults**. If one is missing, start-up aborts instead of silently running against a
> localhost issuer that does not exist in production.

## Roadmap

- [x] In-memory store replaced by Postgres with row-level security — `STORE=pg` + `src/store-pg.ts` + `migrations/001_notes_rls.sql`
- [x] Token exchange for downstream API calls (no pass-through) — `src/token-exchange.ts` (RFC 8693)
- [x] Deploy guide (container + reverse-proxy TLS) — `Dockerfile` + `docs/deploy.md`
- [x] Origin validation against DNS rebinding — `ALLOWED_ORIGINS`, checked before auth
- [ ] Replace the dev issuer with a real IdP integration (WorkOS/Auth0/Keycloak)

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

Uses a **development-only** OAuth issuer stub for local testing. Do **not** use
`scripts/dev-issuer.mjs` and `.dev-keys.json` in production.

## Provider

Yimmie Honrodt, sole proprietorship, Cologne, Germany — **provider identification under § 5 DDG:**
https://honrodt.de/impressum · Contact: kontakt@honrodt.de

## License

Apache-2.0

---

## Liability and warranty

This project is licensed under the **Apache License 2.0** and is provided as is ("AS IS", without
warranties or conditions of any kind). Liability for damages arising from its use is excluded to the
extent permitted by law — see `LICENSE`, sections 7 and 8, for details.

**This is a reference implementation, not a hardened product.** It shows how the security layer can
be built; responsibility for operating and securing any system derived from it stays with the
operator.

**Only test third-party systems with the operator's documented permission.** Without authorisation
even a scan can be unlawful.
