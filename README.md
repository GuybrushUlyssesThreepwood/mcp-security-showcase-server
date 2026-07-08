# mcp-showcase-server

**Ein Referenz-MCP-Server, der die Security-Schicht richtig macht.**

Während [`mcp-sec-scan`](../mcp-sec-scan) zeigt *„Ich finde die Fehler"*, zeigt dieses Repo
*„Ich baue es korrekt."* Es ist ein produktionsnaher Model-Context-Protocol-Server (Streamable HTTP)
mit den vier Dingen, die SaaS-Teams wirklich brauchen, bevor sie KI-Agenten ins Produkt lassen:

- 🔐 **OAuth-2.1-Resource-Server** — validiert Bearer-JWTs gegen die JWKS des IdP (Signatur, Issuer, Audience, Ablauf). PKCE/S256 vom Authorization-Server angekündigt.
- 🧱 **Strikte Mandantentrennung** — der Mandant wird **ausschließlich** aus dem verifizierten Token gelesen, nie aus einem Request-Parameter. Jede Store-Operation ist mandantengebunden. Fremdmandanten-Zugriff liefert *„not found"* (kein Existenz-Leak).
- 📒 **Strukturiertes Audit-Log** — append-only JSON Lines: wer · Mandant · Tool · Params (redigiert) · Ergebnis · Zeit.
- 🚦 **Rate-Limiting pro Mandant** — Fixed-Window-Limiter, `429 + Retry-After`, schützt vor Agenten-Loops / Kosten-Explosion.
- 🧯 **Least-Privilege-Scopes** pro Tool, generische Fehlerantworten (kein Stacktrace-/Secret-Leak), restriktives CORS.

> Die HTTP-/Security-Schicht ist bewusst explizit geschrieben (nicht in einem Framework versteckt) —
> sie *ist* das Produkt. Eine echte Domain-API und ein echter IdP lassen sich hinter denselben
> Schnittstellen einsetzen (siehe [`docs/api-auswahl.md`](docs/api-auswahl.md)).

---

## Lokal starten (2 Terminals)

```bash
npm install
npm run build

# Terminal 1 — Dev-OAuth-Issuer (RS256 JWKS + AS-Metadaten mit PKCE S256)
npm run issuer

# Terminal 2 — der MCP-Server
npm start
```

Token erzeugen und aufrufen:

```bash
TOKEN=$(node scripts/dev-issuer.mjs mint acme notes:read,notes:write)

curl -s -X POST http://127.0.0.1:8970/mcp \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Ohne Token gibt es `401` + einen `WWW-Authenticate`-Header, der auf die Resource-Metadaten zeigt.

## Mandantentrennung beweisen

Ein `globex`-Token kann keine `acme`-Notiz lesen — gleiche ID, anderer Mandant → `Note not found`:

```bash
ACME=$(node scripts/dev-issuer.mjs mint acme notes:read,notes:write)
GLOBEX=$(node scripts/dev-issuer.mjs mint globex notes:read,notes:write)
# als acme anlegen, dann als globex mit der zurückgegebenen ID lesen → not found
```

## Dogfooding

Unseren eigenen Scanner dagegen laufen lassen:

```bash
node ../mcp-sec-scan/dist/cli.js http://127.0.0.1:8970/mcp --token "$ACME" --active
```

Ergebnis: Auth erzwungen ✅, keine unauth. Tools ✅, PKCE S256 ✅, kein Tool-Poisoning ✅,
restriktives CORS ✅, kein Fehler-Leak ✅. Das einzige lokale Finding ist **TLS** (weil localhost über
HTTP läuft) — in Produktion hinter HTTPS besteht der Check. Die Rate-Limit-WARN ist erwartet: ein
unauthentifizierter externer Scanner kann ein *mandantenbezogenes* Limit nicht beobachten (es greift
erst nach der Auth).

## Tests

```bash
npm test
```

26 Tests (`node:test`), die die Security-Zusagen beweisen — nicht nur, dass der Code kompiliert:

- **Auth** (`test/auth.test.ts`) — echte RS256-JWT-Verifikation gegen einen lokalen JWKS-Server: gültiges Token liefert Mandant/Scopes; falsche **Audience**, falscher **Issuer**, **abgelaufenes** und **signatur-manipuliertes** Token werden alle abgelehnt; ein Token **ohne Mandanten-Claim** wird verweigert (der Mandant kommt nur aus dem Token).
- **Mandantentrennung** (`test/store.test.ts`, `test/tools.test.ts`) — ein Mandant sieht nur seine eigenen Notizen; ein mandantenübergreifendes `get_note` mit echter ID liefert *„not found"* (kein Existenz-Leak).
- **Least Privilege** (`test/tools.test.ts`) — jedes Tool erzwingt seinen Scope (`notes:read` / `notes:write`).
- **Rate-Limiting** (`test/ratelimit.test.ts`) — erlaubt bis `max`, dann `429`; pro Mandant; Fenster wird zurückgesetzt.
- **Audit-Log** (`test/audit.test.ts`) — append-only JSON Lines; Secret-haltige Keys redigiert; lange Params gekürzt.

CI (`.github/workflows/ci.yml`) führt Typecheck + Tests + Build aus, startet dann den Server und prüft,
dass ein unauthentifiziertes `tools/list` mit `401` abgelehnt wird.

## Tools

| Tool | Scope | Beschreibung |
|------|-------|--------------|
| `list_notes` | `notes:read` | Notizen des Mandanten auflisten |
| `get_note` | `notes:read` | Eine Notiz holen (mandantengebunden) |
| `create_note` | `notes:write` | Notiz für den Mandanten anlegen |

## Konfiguration (Env)

| Variable | Standard | Bedeutung |
|----------|----------|-----------|
| `PORT` | 8970 | Server-Port |
| `RESOURCE_URL` | `http://127.0.0.1:8970` | Öffentliche Basis-URL / Token-Audience |
| `OAUTH_ISSUER` | `http://127.0.0.1:8969` | IdP-Issuer |
| `OAUTH_JWKS_URI` | Issuer `/.well-known/jwks.json` | JWKS-Endpoint |
| `TENANT_CLAIM` | `tenant` | Token-Claim mit der Mandanten-ID |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | 60 / 60000 | Limit pro Mandant |
| `AUDIT_LOG_PATH` | `audit.log.jsonl` | Audit-Log-Datei |

## Launch-Scope (T-103) & Roadmap

Ausgeliefert für den Launch am 10. Aug: echte Tools + OAuth-2.1/PKCE-Validierung + Mandantentrennung +
Audit-Log + Rate-Limiting. Roadmap (öffentlich, dient zugleich als Content laut T-203):

- [x] In-Memory-Store durch Postgres mit Row-Level-Security ersetzt — `STORE=pg` + `src/store-pg.ts` + `migrations/001_notes_rls.sql`
- [x] Token-Exchange für nachgelagerte API-Calls (kein Passthrough) — `src/token-exchange.ts` (RFC 8693)
- [x] Deploy-Guide (Container + Reverse-Proxy-TLS) — `Dockerfile` + `docs/deploy.md`
- [ ] Dev-Issuer durch echte IdP-Integration ersetzen (WorkOS/Auth0/Keycloak) — braucht deinen IdP-Account
- [ ] Wird zum Keim des lizenzierten Starter-Kits (T-801/T-802)

### Store-Backends
```bash
# Standard: In-Memory (Demo-Seeds)
npm start
# Postgres mit RLS:
psql "$ADMIN_URL" -f migrations/001_notes_rls.sql
STORE=pg DATABASE_URL="postgres://mcp_app:...@host/db" npm install pg && npm start
```
Siehe [docs/deploy.md](docs/deploy.md).

## ⚠️ Hinweis

Nutzt einen **nur für Dev** gedachten OAuth-Issuer-Stub für lokales Testen. `scripts/dev-issuer.mjs`
und `.dev-keys.json` **nicht** in Produktion verwenden.

## Lizenz

Apache-2.0
