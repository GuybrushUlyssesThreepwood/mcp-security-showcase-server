# Contributing to mcp-showcase-server

This repo is a **teaching reference** for a production-grade MCP server (OAuth 2.1, tenant isolation, audit
logging, rate limiting). Contributions that make it clearer or more correct are welcome.

## Development
```bash
npm install
npm run typecheck
npm run build

# run it (2 terminals)
npm run issuer     # dev OAuth issuer
npm start          # the server
```

## Guiding principles (please preserve)
- **Tenant comes only from the verified token** — never from a request parameter.
- **Explicit security layers** — auth → rate-limit → dispatch → audit, readable in `src/server.ts`.
- **Least privilege** — scopes enforced per tool.
- **No secret leakage** — generic errors outward; secrets redacted in the audit log.

## Interfaces to extend
- `TenantStore` (`src/store.ts`) — swap the in-memory store for a real DB (see the Postgres adapter).
- `TOOLS` (`src/tools.ts`) — add tenant-scoped, scope-checked tools.

## PRs
Keep changes focused and typechecked. Update `CHANGELOG.md` and the README roadmap where relevant.
