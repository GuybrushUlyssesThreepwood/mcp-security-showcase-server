# Security Policy

This is a **reference** MCP server demonstrating a secure implementation. It is meant to be read, run
locally, and adapted — not deployed as-is.

## Reporting a vulnerability
If you find a security weakness in the reference implementation, report it **privately**:
- Email: **kontakt@honrodt.de** (Geschäftsadresse; eine eigene Produkt-Domain folgt)
- Provider identification (Impressum, § 5 DDG): https://honrodt.de/impressum
- Or GitHub private vulnerability reporting (Security tab).

Please do not open a public issue for security reports.

## Important: not production configuration
- `scripts/dev-issuer.mjs` and `.dev-keys.json` are a **development-only** OAuth stub. **Never** use them in
  production. Replace with a real IdP.
- The default store is **in-memory**. Use a real database with tenant-scoped access (e.g. Postgres RLS) for
  anything real. See `docs/deploy.md` and the Postgres adapter.
- Always run behind **TLS** in production.
