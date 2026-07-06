// DEV-ONLY OAuth-Authorization-Server-Stub für lokales Testen des Showcase-Servers.
// NICHT für Produktion. Persistiert ein RS256-Schlüsselpaar in .dev-keys.json, damit der
// laufende Issuer und der `mint`-Befehl denselben Schlüssel nutzen. Serviert JWKS + AS-Metadaten
// (inkl. PKCE S256) und kann Access-Tokens minten.
//
//   node scripts/dev-issuer.mjs            -> startet den Issuer (Port 8969)
//   node scripts/dev-issuer.mjs mint acme notes:read,notes:write   -> druckt ein Token
//
// Für den echten Betrieb ersetzt ein richtiger IdP (Auth0, WorkOS, Keycloak, …) diesen Stub.

import { createServer } from "node:http";
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { generateKeyPair, exportJWK, importJWK, SignJWT } from "jose";

const PORT = Number(process.env.ISSUER_PORT ?? 8969);
const ISSUER = process.env.OAUTH_ISSUER ?? `http://127.0.0.1:${PORT}`;
const AUDIENCE = process.env.OAUTH_AUDIENCE ?? `http://127.0.0.1:${process.env.PORT ?? 8970}`;
const KID = "dev-key-1";
const KEY_FILE = join(dirname(fileURLToPath(import.meta.url)), "..", ".dev-keys.json");

async function loadOrCreateKeys() {
  if (existsSync(KEY_FILE)) {
    const { privateJwk, publicJwk } = JSON.parse(await readFile(KEY_FILE, "utf8"));
    const privateKey = await importJWK(privateJwk, "RS256");
    return { privateKey, publicJwk };
  }
  const { publicKey, privateKey } = await generateKeyPair("RS256", { extractable: true });
  const privateJwk = { ...(await exportJWK(privateKey)), kid: KID, alg: "RS256", use: "sig" };
  const publicJwk = { ...(await exportJWK(publicKey)), kid: KID, alg: "RS256", use: "sig" };
  await writeFile(KEY_FILE, JSON.stringify({ privateJwk, publicJwk }, null, 2), "utf8");
  return { privateKey, publicJwk };
}

const { privateKey, publicJwk } = await loadOrCreateKeys();

async function mint(tenant, scope) {
  return new SignJWT({ tenant, scope })
    .setProtectedHeader({ alg: "RS256", kid: KID })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setSubject(`user@${tenant}`)
    .setIssuedAt()
    .setExpirationTime("1h")
    .sign(privateKey);
}

if (process.argv[2] === "mint") {
  const tenant = process.argv[3] ?? "acme";
  const scope = (process.argv[4] ?? "notes:read,notes:write").split(",").join(" ");
  console.log(await mint(tenant, scope));
  process.exit(0);
}

const asMetadata = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}/authorize`,
  token_endpoint: `${ISSUER}/token`,
  jwks_uri: `${ISSUER}/.well-known/jwks.json`,
  response_types_supported: ["code"],
  grant_types_supported: ["authorization_code", "client_credentials"],
  // OAuth 2.1: PKCE S256 wird angeboten — genau das prüft mcp-sec-scan.
  code_challenge_methods_supported: ["S256"],
  token_endpoint_auth_methods_supported: ["none", "client_secret_basic"],
  scopes_supported: ["notes:read", "notes:write"],
};

createServer((req, res) => {
  const url = new URL(req.url, ISSUER);
  const send = (code, body) => {
    res.writeHead(code, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/.well-known/jwks.json") return send(200, { keys: [publicJwk] });
  if (url.pathname === "/.well-known/oauth-authorization-server") return send(200, asMetadata);
  if (url.pathname === "/healthz") return send(200, { status: "ok" });
  return send(404, { error: "not_found" });
}).listen(PORT, () => {
  console.log(`dev issuer on ${ISSUER}`);
  console.log(`  JWKS:     ${ISSUER}/.well-known/jwks.json`);
  console.log(`  AS meta:  ${ISSUER}/.well-known/oauth-authorization-server`);
  console.log(`  mint a token: node scripts/dev-issuer.mjs mint acme notes:read,notes:write`);
});
