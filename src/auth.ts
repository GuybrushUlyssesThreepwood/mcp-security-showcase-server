// OAuth 2.1 Resource-Server-Logik: Bearer-JWT gegen JWKS des IdP prüfen.
// Strikt: Signatur, issuer, audience und expiry werden validiert. Tenant kommt NUR aus dem Token.

import { createRemoteJWKSet, jwtVerify, type JWTPayload } from "jose";
import type { Config } from "./config.js";

export interface AuthContext {
  subject: string;
  tenant: string;
  scopes: string[];
  raw: JWTPayload;
}

export class AuthError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

export function createVerifier(cfg: Config) {
  // Remote JWKS mit Caching/Rotation-Handling durch jose.
  const jwks = createRemoteJWKSet(new URL(cfg.jwksUri));

  return async function verify(authHeader: string | undefined): Promise<AuthContext> {
    if (!authHeader || !authHeader.toLowerCase().startsWith("bearer ")) {
      throw new AuthError("missing_token", "Authorization: Bearer <token> required");
    }
    const token = authHeader.slice(7).trim();

    let payload: JWTPayload;
    try {
      const res = await jwtVerify(token, jwks, {
        issuer: cfg.issuer,
        audience: cfg.audience,
        // clockTolerance klein halten; erzwingt Expiry-Prüfung.
        clockTolerance: 5,
      });
      payload = res.payload;
    } catch (err) {
      throw new AuthError("invalid_token", err instanceof Error ? err.message : "token verification failed");
    }

    // Tenant AUSSCHLIESSLICH aus dem verifizierten Token — nie aus Request-Body/Param.
    const tenant = payload[cfg.tenantClaim];
    if (typeof tenant !== "string" || tenant.length === 0) {
      throw new AuthError("no_tenant", `Token missing required tenant claim '${cfg.tenantClaim}'`);
    }

    const scopeRaw = (payload.scope ?? payload.scp ?? "") as string | string[];
    const scopes = Array.isArray(scopeRaw) ? scopeRaw : scopeRaw.split(" ").filter(Boolean);

    return {
      subject: typeof payload.sub === "string" ? payload.sub : "unknown",
      tenant,
      scopes,
      raw: payload,
    };
  };
}

/** Least-Privilege: Tool verlangt bestimmten Scope. */
export function requireScope(ctx: AuthContext, scope: string): void {
  if (!ctx.scopes.includes(scope)) {
    throw new AuthError("insufficient_scope", `Required scope '${scope}' not granted`);
  }
}

/** RFC 9728 — Protected Resource Metadata (verweist auf den Authorization Server). */
export function protectedResourceMetadata(cfg: Config) {
  return {
    resource: cfg.resourceUrl,
    authorization_servers: [cfg.issuer],
    bearer_methods_supported: ["header"],
    scopes_supported: ["notes:read", "notes:write"],
  };
}
