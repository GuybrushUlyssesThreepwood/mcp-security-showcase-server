// Einstiegspunkt: Konfiguration laden, Abhängigkeiten verdrahten, Server starten.

import { loadConfig } from "./config.js";
import { createVerifier } from "./auth.js";
import { TenantStore } from "./store.js";
import { AuditLog } from "./audit.js";
import { RateLimiter } from "./ratelimit.js";
import { buildServer } from "./server.js";

const cfg = loadConfig();
const store = new TenantStore();

// Demo-Seeds: zwei Tenants mit je eigenen Notizen (belegt die Isolation).
store.seed([
  { tenant: "acme", title: "Acme roadmap", body: "Q3 launch", createdBy: "seed" },
  { tenant: "globex", title: "Globex secret", body: "internal", createdBy: "seed" },
]);

const deps = {
  cfg,
  store,
  audit: new AuditLog(cfg.auditLogPath),
  limiter: new RateLimiter(cfg.rateLimitMax, cfg.rateLimitWindowMs),
  verify: createVerifier(cfg),
};

buildServer(deps).listen(cfg.port, () => {
  console.log(`mcp-showcase-server on ${cfg.resourceUrl}  (MCP endpoint: POST /mcp)`);
  console.log(`  issuer=${cfg.issuer}  audience=${cfg.audience}  tenantClaim=${cfg.tenantClaim}`);
  console.log(`  metadata: GET ${cfg.resourceUrl}/.well-known/oauth-protected-resource`);
});
