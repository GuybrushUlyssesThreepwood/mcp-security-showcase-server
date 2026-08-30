// Token exchange for downstream calls (RFC 8693) — the correct way instead of token pass-through.
//
// The problem: an MCP server that simply forwards the incoming user token to a downstream API is a
// "confused deputy" (see security checklist #3/#4). Instead the server exchanges the incoming token
// at the authorization server for a *new* token intended for the downstream API — carrying the
// user's identity, but with the correct audience and a minimal scope.
//
// Requires a real IdP that supports token exchange (grant_type
// urn:ietf:params:oauth:grant-type:token-exchange). The dev issuer stub does NOT — this helper is
// for the production path.

export interface TokenExchangeConfig {
  tokenEndpoint: string;
  clientId: string;
  clientSecret: string;
}

export interface ExchangeResult {
  accessToken: string;
  expiresIn?: number;
  tokenType: string;
}

/**
 * Exchanges the incoming access token for a downstream token for `audience`/`scope`.
 * Throws on failure — the caller should then refuse the tool call with -32003 (never pass through!).
 */
export async function exchangeToken(
  cfg: TokenExchangeConfig,
  subjectToken: string,
  audience: string,
  scope: string[]
): Promise<ExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: subjectToken,
    subject_token_type: "urn:ietf:params:oauth:token-type:access_token",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
    audience,
    scope: scope.join(" "),
  });

  const auth = Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString("base64");
  const res = await fetch(cfg.tokenEndpoint, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      authorization: `Basic ${auth}`,
    },
    body,
  });

  if (!res.ok) {
    throw new Error(`token exchange failed: HTTP ${res.status}`);
  }
  const json = (await res.json()) as { access_token?: string; expires_in?: number; token_type?: string };
  if (!json.access_token) throw new Error("token exchange returned no access_token");
  return { accessToken: json.access_token, expiresIn: json.expires_in, tokenType: json.token_type ?? "Bearer" };
}
