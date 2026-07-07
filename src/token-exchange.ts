// Token-Exchange für Downstream-Aufrufe (RFC 8693) — der richtige Weg statt Token-Passthrough.
//
// Problem: Ein MCP-Server, der das eingehende Nutzer-Token einfach an eine Downstream-API weiterreicht,
// ist ein "confused deputy" (siehe Security-Checkliste #3/#4). Stattdessen tauscht der Server das
// eingehende Token beim Authorization Server gegen ein *neues*, für die Downstream-API bestimmtes Token —
// mit der Identität des Nutzers, aber korrekter audience und minimalem Scope.
//
// Voraussetzung: ein echter IdP, der Token-Exchange (grant_type urn:ietf:params:oauth:grant-type:token-exchange)
// unterstützt. Der Dev-Issuer-Stub tut das NICHT — dieser Helfer ist für den Produktionspfad.

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
 * Tauscht das eingehende Access-Token gegen ein Downstream-Token für `audience`/`scope`.
 * Wirft bei Fehlschlag — der Aufrufer sollte den Tool-Call dann mit -32003 ablehnen (nicht durchreichen!).
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
