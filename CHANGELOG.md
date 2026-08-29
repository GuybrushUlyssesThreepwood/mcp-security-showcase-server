# Changelog

## [0.2.0] - 2026-08-29
### Added
- **Origin validation against DNS rebinding.** The MCP Streamable HTTP spec requires it and this
  server did not do it — the one control its own scanner has a check for. Enforced **before**
  authentication: a valid bearer token does not make a foreign `Origin` acceptable, because what is
  being checked is where the request came from, not who sent it. Allow-list via `ALLOWED_ORIGINS`;
  requests without an `Origin` header (CLI, agent, server-to-server) pass, any other origin gets
  `403`.
- `test/server.test.ts`: five tests over the real HTTP layer covering the origin rules and the body
  limit.
- CI now also asserts that a foreign `Origin` is refused with `403` — a `401` there would mean the
  check has slipped behind the auth layer.

### Changed
- **The audit log no longer records parameter values, only parameter names.** `redact()` masks by
  key name, so `create_note` wrote every note title and body into the log verbatim while the README,
  the module header and the deploy guide all claimed PII was redacted. An audit log answers "who did
  what, when", not "what did it say" — and one that copies user content inherits a retention problem
  it should not have.
- **Required OAuth settings have no fallback under `NODE_ENV=production`.** `req()` supplied a
  localhost default for every one of them, so the "fail-fast on missing values" the module header
  promised never happened: a production deployment missing `OAUTH_ISSUER` came up silently pointing
  at an issuer that does not exist there.
- The server refuses to start when the audit log path is not writable. Write errors are still
  swallowed per request (a full disk must not kill traffic), which meant a permanently unwritable
  path never surfaced at all.

### Fixed
- **The audit log was silently disabled in the shipped container.** The Dockerfile switches to
  `USER node` while `/app` is owned by root, so every append to the default relative
  `audit.log.jsonl` failed — and `write()` catches those by design. The image now writes to
  `/var/log/mcp`, owned by `node` and declared as a volume.
- **An oversized request body could never be reported.** `readBody` called `req.destroy()` on
  exceeding the limit, tearing down the socket before the response was written; callers saw
  `ECONNRESET`. It now stops buffering, drains and discards the rest, and answers `413` — the memory
  is what needs bounding, not the connection. A client that keeps sending past ten times the limit
  is still cut off.
- An oversized body was reported as JSON-RPC `-32700 Parse error`, sending callers to look for a
  syntax error in well-formed JSON.
- The README linked to `../mcp-sec-scan`, a relative path that resolves only on a local disk and
  404s on GitHub.
- Corrected the claim of "restriktives CORS": the server sets no CORS headers at all. That is the
  most restrictive setting available for a token-only API, but it is not a configured CORS policy.
- Removed internal ticket ids (T-103, T-203, T-801/802) and the internal positioning section from
  the public README.

## [0.1.0] - 2026-08-10
### Added
- OAuth 2.1 resource server: JWT verification against JWKS (signature, issuer, audience, expiry).
- Strict multi-tenant isolation: tenant read only from the verified token; per-tenant partitioned store;
  cross-tenant access returns "not found" (no existence leak).
- Structured append-only audit log (JSON Lines) with secret redaction.
- Per-tenant fixed-window rate limiting (`429` + `Retry-After`).
- Least-privilege scopes enforced per tool; generic error responses.
- Protected-resource metadata endpoint (RFC 9728 style) + `WWW-Authenticate` on 401.
- Dev-only OAuth issuer stub (RS256 JWKS + AS metadata with PKCE S256) for local testing.
- Postgres store with Row-Level-Security (`src/store-pg.ts` + `migrations/001_notes_rls.sql`).
- Token exchange for downstream API calls, no passthrough (`src/token-exchange.ts`, RFC 8693).
- Container + reverse-proxy TLS deploy guide (`Dockerfile`, `docs/deploy.md`).
- **Test suite (26 tests, `node:test`)** proving the security properties: real RS256 JWT verification
  (audience/issuer/expiry/tamper/tenant-claim), tenant isolation at store + tool layers (no cross-tenant
  read, no existence leak), per-tool scope enforcement, per-tenant rate limiting, and audit-log redaction.
- **CI workflow** (`.github/workflows/ci.yml`): typecheck + tests + build, then starts the server and
  asserts an unauthenticated `tools/list` is refused with `401`.
