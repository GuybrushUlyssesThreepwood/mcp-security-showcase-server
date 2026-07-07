# Changelog

## [0.1.0] - 2026-08 (planned public release)
### Added
- OAuth 2.1 resource server: JWT verification against JWKS (signature, issuer, audience, expiry).
- Strict multi-tenant isolation: tenant read only from the verified token; per-tenant partitioned store;
  cross-tenant access returns "not found" (no existence leak).
- Structured append-only audit log (JSON Lines) with secret redaction.
- Per-tenant fixed-window rate limiting (`429` + `Retry-After`).
- Least-privilege scopes enforced per tool; generic error responses.
- Protected-resource metadata endpoint (RFC 9728 style) + `WWW-Authenticate` on 401.
- Dev-only OAuth issuer stub (RS256 JWKS + AS metadata with PKCE S256) for local testing.
- Passes `mcp-sec-scan` (auth, PKCE, unauth-tools, poisoning, CORS, error verbosity).

### Roadmap
- Postgres store with Row-Level-Security (adapter + migration).
- Real IdP integration guide (WorkOS/Auth0/Keycloak).
- Token-exchange for downstream API calls (no passthrough).
- Container + reverse-proxy TLS deploy guide.
- Seed of the licensed Starter-Kit.
