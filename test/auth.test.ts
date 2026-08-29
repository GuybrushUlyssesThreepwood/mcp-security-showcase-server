// Beweist die Kern-Auth: RS256-JWT gegen JWKS geprüft, mit Signatur/Issuer/Audience/Expiry.
// Tenant kommt AUSSCHLIESSLICH aus dem verifizierten Token. Ein lokaler JWKS-Server ersetzt den IdP.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { createVerifier, requireScope, AuthError, type AuthContext } from "../src/auth.js";
import type { Config } from "../src/config.js";

const JWKS_PORT = 8965;
const ISSUER = `http://127.0.0.1:${JWKS_PORT}`;
const AUDIENCE = "http://127.0.0.1:8970";
const KID = "test-key-1";

let server: Server;
let privateKey: Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

function cfg(): Config {
  return {
    port: 8970,
    resourceUrl: AUDIENCE,
    issuer: ISSUER,
    jwksUri: `${ISSUER}/.well-known/jwks.json`,
    audience: AUDIENCE,
    tenantClaim: "tenant",
    rateLimitMax: 60,
    rateLimitWindowMs: 60_000,
    auditLogPath: "audit.log.jsonl",
    store: "memory",
    allowedOrigins: [],
  };
}

interface MintOpts {
  tenant?: unknown;
  scope?: string;
  aud?: string;
  iss?: string;
  expiredBySeconds?: number;
}

async function mint(opts: MintOpts = {}): Promise<string> {
  const claims: Record<string, unknown> = { scope: opts.scope ?? "notes:read notes:write" };
  if (opts.tenant !== undefined) claims.tenant = opts.tenant;
  const jwt = new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(opts.iss ?? ISSUER)
    .setAudience(opts.aud ?? AUDIENCE)
    .setSubject("user@acme")
    .setIssuedAt();
  if (opts.expiredBySeconds) {
    jwt.setExpirationTime(Math.floor(Date.now() / 1000) - opts.expiredBySeconds);
  } else {
    jwt.setExpirationTime("1h");
  }
  return jwt.sign(privateKey);
}

before(async () => {
  const kp = await generateKeyPair("RS256", { extractable: true });
  privateKey = kp.privateKey;
  const publicJwk = { ...(await exportJWK(kp.publicKey)), kid: KID, alg: "RS256", use: "sig" };
  server = createServer((req, res) => {
    if ((req.url ?? "").startsWith("/.well-known/jwks.json")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ keys: [publicJwk] }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(JWKS_PORT, resolve));
});

after(() => {
  server.close();
});

test("a valid token yields tenant, subject and scopes from the token", async () => {
  const verify = createVerifier(cfg());
  const ctx = await verify(`Bearer ${await mint({ tenant: "acme", scope: "notes:read" })}`);
  assert.equal(ctx.tenant, "acme");
  assert.equal(ctx.subject, "user@acme");
  assert.deepEqual(ctx.scopes, ["notes:read"]);
});

test("missing or malformed Authorization header is rejected as missing_token", async () => {
  const verify = createVerifier(cfg());
  await assert.rejects(() => verify(undefined), (e: unknown) => e instanceof AuthError && e.code === "missing_token");
  await assert.rejects(() => verify("Basic abc"), (e: unknown) => e instanceof AuthError && e.code === "missing_token");
});

test("a token for a different audience is rejected", async () => {
  const verify = createVerifier(cfg());
  await assert.rejects(
    async () => verify(`Bearer ${await mint({ tenant: "acme", aud: "http://evil.example" })}`),
    (e: unknown) => e instanceof AuthError && e.code === "invalid_token"
  );
});

test("a token from a different issuer is rejected", async () => {
  const verify = createVerifier(cfg());
  await assert.rejects(
    async () => verify(`Bearer ${await mint({ tenant: "acme", iss: "http://evil.example" })}`),
    (e: unknown) => e instanceof AuthError && e.code === "invalid_token"
  );
});

test("an expired token is rejected", async () => {
  const verify = createVerifier(cfg());
  await assert.rejects(
    async () => verify(`Bearer ${await mint({ tenant: "acme", expiredBySeconds: 3600 })}`),
    (e: unknown) => e instanceof AuthError && e.code === "invalid_token"
  );
});

test("a token without the tenant claim is rejected as no_tenant (tenant only from token)", async () => {
  const verify = createVerifier(cfg());
  await assert.rejects(
    async () => verify(`Bearer ${await mint({ tenant: undefined })}`),
    (e: unknown) => e instanceof AuthError && e.code === "no_tenant"
  );
});

test("a tampered signature is rejected", async () => {
  const verify = createVerifier(cfg());
  const token = await mint({ tenant: "acme" });
  // Letztes Zeichen der Signatur kippen.
  const tampered = token.slice(0, -1) + (token.endsWith("A") ? "B" : "A");
  await assert.rejects(
    () => verify(`Bearer ${tampered}`),
    (e: unknown) => e instanceof AuthError && e.code === "invalid_token"
  );
});

test("requireScope enforces least privilege", () => {
  const ctx: AuthContext = { subject: "u", tenant: "acme", scopes: ["notes:read"], raw: {} };
  assert.doesNotThrow(() => requireScope(ctx, "notes:read"));
  assert.throws(
    () => requireScope(ctx, "notes:write"),
    (e: unknown) => e instanceof AuthError && e.code === "insufficient_scope"
  );
});
