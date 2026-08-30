# Swapping the domain

The server uses a deliberately unremarkable notes store as its domain. That is not a placeholder you
have to look past, it is the point: what this repo demonstrates is the security layer — OAuth 2.1
verification, tenant isolation, origin validation, scopes, audit, rate limiting. A more interesting
domain would distract from that and would need third-party API keys just to start. As it is, the
server runs standalone.

To put it in front of a real API, exactly one building block is replaced.

## What to replace

**1. The store** (`src/store.ts`). The `Store` interface takes `tenant` as the first argument of
every operation — not for style, but so that no signature exists through which a cross-tenant read
could happen by accident. An adapter against a third-party API implements the same interface;
`src/store-pg.ts` shows this for Postgres with row-level security.

**2. The tools** (`src/tools.ts`). Every handler receives `(args, ctx, store)` and starts with
`requireScope(ctx, "...")`. The tenant comes from `ctx.tenant`, i.e. from the verified token —
**never** from `args`. That is the rule whose violation defeats tenant isolation, and it is pinned
down in `test/tools.test.ts`.

## What to watch out for with a third-party API

- **Tenant model.** Does the target API know about tenants at all, or do you work through a single
  service account? In the second case the separation has to happen entirely inside this server —
  every query then filters by `ctx.tenant`, and one forgotten filter is a data leak with no second
  line of defence. An API with a real tenant concept is considerably safer.
- **No token pass-through.** The incoming user token is not forwarded to the target API — that would
  be a confused deputy. Use token exchange per RFC 8693 instead, see `src/token-exchange.ts`.
- **The target API's rate limits.** The limit here protects this server; the quota over there is a
  second one and needs its own budgeting.
- **Error propagation.** Errors from the target API must not go out raw: they regularly contain
  internal paths, account ids or field names. `dispatch` in `src/server.ts` answers anything
  unexpected generically and logs the cause internally only.
