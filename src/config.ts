// Zentrale Konfiguration aus Umgebungsvariablen. Fail-fast bei fehlenden Pflichtwerten.

export interface Config {
  port: number;
  /** Öffentliche Basis-URL dieses Resource-Servers (für Metadaten & audience). */
  resourceUrl: string;
  /** OAuth Authorization Server Issuer (IdP). */
  issuer: string;
  /** JWKS-URI des Authorization Servers. */
  jwksUri: string;
  /** Erwartete audience im Access Token (i. d. R. = resourceUrl). */
  audience: string;
  /** Claim, aus dem die Tenant-ID gelesen wird. */
  tenantClaim: string;
  /** Rate-Limit: erlaubte Requests pro Tenant im Fenster. */
  rateLimitMax: number;
  /** Rate-Limit-Fenster in ms. */
  rateLimitWindowMs: number;
  /** Pfad der Audit-Log-Datei (JSON Lines). */
  auditLogPath: string;
  /** Store-Backend: "memory" (Default) oder "pg". */
  store: "memory" | "pg";
  /** Postgres-Verbindung (nur bei store=pg). */
  databaseUrl?: string;
  /** Erlaubte Origin-Header. Leer = jeder Origin wird abgelehnt (nur origin-lose Clients). */
  allowedOrigins: string[];
}

/**
 * Pflichtwert aus der Umgebung.
 *
 * Die Fallbacks sind reine Entwicklungswerte (localhost-Issuer, localhost-Audience). In Produktion
 * sind sie gefährlich: fehlt OAUTH_ISSUER, liefe der Server still gegen einen IdP, den es dort nicht
 * gibt, statt beim Start zu scheitern. Deshalb greifen Fallbacks nur außerhalb von NODE_ENV=production.
 */
function req(name: string, devFallback?: string): string {
  const v = process.env[name];
  if (v !== undefined && v !== "") return v;
  if (process.env.NODE_ENV === "production" || devFallback === undefined) {
    throw new Error(
      `Missing required env var: ${name}` +
        (devFallback !== undefined ? " (a development default exists, but it is not used in production)" : "")
    );
  }
  return devFallback;
}

export function loadConfig(): Config {
  const port = Number(process.env.PORT ?? 8970);
  const resourceUrl = req("RESOURCE_URL", `http://127.0.0.1:${port}`);
  return {
    port,
    resourceUrl,
    issuer: req("OAUTH_ISSUER", "http://127.0.0.1:8969"),
    jwksUri: req("OAUTH_JWKS_URI", "http://127.0.0.1:8969/.well-known/jwks.json"),
    audience: req("OAUTH_AUDIENCE", resourceUrl),
    tenantClaim: process.env.TENANT_CLAIM ?? "tenant",
    rateLimitMax: Number(process.env.RATE_LIMIT_MAX ?? 60),
    rateLimitWindowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60000),
    auditLogPath: process.env.AUDIT_LOG_PATH ?? "audit.log.jsonl",
    store: process.env.STORE === "pg" ? "pg" : "memory",
    databaseUrl: process.env.DATABASE_URL,
    allowedOrigins: (process.env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((o) => o.trim())
      .filter(Boolean),
  };
}
