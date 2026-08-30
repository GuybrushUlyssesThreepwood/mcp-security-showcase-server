// Entry point: load configuration, wire up dependencies, start the server.

import { loadConfig } from "./config.js";
import { createVerifier } from "./auth.js";
import { TenantStore, type Store } from "./store.js";
import { AuditLog } from "./audit.js";
import { RateLimiter } from "./ratelimit.js";
import { buildServer } from "./server.js";

const cfg = loadConfig();

async function makeStore(): Promise<Store> {
  if (cfg.store === "pg") {
    if (!cfg.databaseUrl) throw new Error("STORE=pg requires DATABASE_URL");
    const { PgTenantStore } = await import("./store-pg.js");
    console.log("store: postgres (RLS)");
    return PgTenantStore.create(cfg.databaseUrl);
  }
  // In-Memory mit Demo-Seeds: zwei Tenants mit je eigenen Notizen (belegt die Isolation).
  const store = new TenantStore();
  store.seed([
    { tenant: "acme", title: "Acme roadmap", body: "Q3 launch", createdBy: "seed" },
    { tenant: "globex", title: "Globex secret", body: "internal", createdBy: "seed" },
  ]);
  console.log("store: in-memory (demo seeds)");
  return store;
}

const store = await makeStore();

const audit = new AuditLog(cfg.auditLogPath);
await audit.assertWritable();

const deps = {
  cfg,
  store,
  audit,
  limiter: new RateLimiter(cfg.rateLimitMax, cfg.rateLimitWindowMs),
  verify: createVerifier(cfg),
};

buildServer(deps).listen(cfg.port, () => {
  console.log(`mcp-showcase-server on ${cfg.resourceUrl}  (MCP endpoint: POST /mcp)`);
  console.log(`  issuer=${cfg.issuer}  audience=${cfg.audience}  tenantClaim=${cfg.tenantClaim}`);
  console.log(
    `  allowed origins: ${cfg.allowedOrigins.length > 0 ? cfg.allowedOrigins.join(", ") : "none (any request carrying an Origin header is rejected)"}`
  );
  console.log(`  metadata: GET ${cfg.resourceUrl}/.well-known/oauth-protected-resource`);
});
