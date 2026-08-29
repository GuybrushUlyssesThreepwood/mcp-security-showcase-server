// Beweist die HTTP-Schicht: Origin-Validierung gegen DNS-Rebinding und die Fehlerkodierung.
// Der Server wird echt gestartet — genau diese Schicht lässt sich nicht sinnvoll unit-testen.

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import type { Server } from "node:http";

import { buildServer } from "../src/server.js";
import { AuditLog } from "../src/audit.js";
import { RateLimiter } from "../src/ratelimit.js";
import { TenantStore } from "../src/store.js";
import type { Config } from "../src/config.js";
import type { AuthContext } from "../src/auth.js";

const auditPath = join(tmpdir(), `server-test-${randomUUID()}.jsonl`);

function testConfig(allowedOrigins: string[]): Config {
  return {
    port: 0,
    resourceUrl: "http://127.0.0.1",
    issuer: "http://127.0.0.1:8969",
    jwksUri: "http://127.0.0.1:8969/.well-known/jwks.json",
    audience: "http://127.0.0.1",
    tenantClaim: "tenant",
    rateLimitMax: 100,
    rateLimitWindowMs: 60000,
    auditLogPath: auditPath,
    store: "memory",
    allowedOrigins,
  };
}

/** Verify-Stub: die Auth selbst ist in auth.test.ts abgedeckt, hier zählt die Reihenfolge. */
const okVerify = async (h: string | undefined): Promise<AuthContext> => {
  if (!h) throw Object.assign(new Error("no token"), { code: "missing_token", name: "AuthError" });
  return { subject: "user@acme", tenant: "acme", scopes: ["notes:read", "notes:write"], raw: {} };
};

async function withServer(
  allowedOrigins: string[],
  fn: (base: string) => Promise<void>
): Promise<void> {
  const srv: Server = buildServer({
    cfg: testConfig(allowedOrigins),
    store: new TenantStore(),
    audit: new AuditLog(auditPath),
    limiter: new RateLimiter(100, 60000),
    verify: okVerify,
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
    await rm(auditPath, { force: true });
  }
}

const rpc = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} });

test("a foreign Origin is rejected with 403 — before authentication", async () => {
  await withServer([], async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://dns-rebind.attacker.example",
        authorization: "Bearer valid-token",
      },
      body: rpc,
    });
    assert.equal(res.status, 403);
    assert.equal((await res.json() as { error: string }).error, "origin_not_allowed");
  });
});

test("a valid token does not buy a foreign Origin past the check", async () => {
  // Die Origin-Prüfung schützt vor DNS-Rebinding — geprüft wird die Herkunft, nicht die Identität.
  await withServer(["https://app.example.com"], async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example", authorization: "Bearer valid-token" },
      body: rpc,
    });
    assert.equal(res.status, 403);
  });
});

test("an allow-listed Origin passes", async () => {
  await withServer(["https://app.example.com"], async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://app.example.com", authorization: "Bearer valid-token" },
      body: rpc,
    });
    assert.equal(res.status, 200);
  });
});

test("a request without an Origin header passes (CLI/agent/server-to-server)", async () => {
  await withServer([], async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
      body: rpc,
    });
    assert.equal(res.status, 200);
  });
});

test("an oversized body is reported as 413, not as a JSON parse error", async () => {
  await withServer([], async (base) => {
    const res = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer valid-token" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: { pad: "x".repeat(1_100_000) } }),
    });
    assert.equal(res.status, 413);
    const body = await res.json() as { error: { code: number; message: string } };
    assert.equal(body.error.message, "Payload too large");
  });
});
