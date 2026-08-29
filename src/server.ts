// HTTP-Layer: MCP-über-Streamable-HTTP als OAuth-2.1-Resource-Server.
// Bewusst explizit (kein Framework), damit die Security-Schichten sichtbar sind — der Verkaufspunkt.
// Reihenfolge pro Request: Sicherheits-Header · Origin · Auth · Rate-Limit · Dispatch · Audit.

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { AuthError, createVerifier, protectedResourceMetadata, type AuthContext } from "./auth.js";
import type { Store } from "./store.js";
import { AuditLog } from "./audit.js";
import { RateLimiter } from "./ratelimit.js";
import { TOOLS, TOOL_MAP, ToolInputError } from "./tools.js";

const PROTOCOL_VERSION = "2025-06-18";

interface Deps {
  cfg: Config;
  store: Store;
  audit: AuditLog;
  limiter: RateLimiter;
  verify: (h: string | undefined) => Promise<AuthContext>;
}

function json(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    // Bewusst KEINE CORS-Header: der Zugriff ist rein tokenbasiert und für Browser-Cross-Origin
    // nicht vorgesehen. Ohne Access-Control-Allow-Origin blockiert der Browser die Antwort —
    // das ist die restriktivste mögliche Einstellung, kein vergessener Header.
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/**
 * Origin-Prüfung gegen DNS-Rebinding (MCP Streamable HTTP: Server MÜSSEN den Origin validieren).
 *
 * Ohne sie kann eine beliebige Webseite den lokal oder im internen Netz erreichbaren Server per
 * DNS-Rebinding ansprechen. Der Bearer-Token schützt davor nicht vollständig: geprüft wird hier die
 * Herkunft der Anfrage, nicht die Identität des Aufrufers.
 *
 * Nicht-Browser-Clients (CLI, Agent, Server-zu-Server) senden gar keinen Origin — die werden
 * durchgelassen, denn ein fehlender Origin ist kein Cross-Site-Kontext. Gesetzte Origins müssen in
 * ALLOWED_ORIGINS stehen; ist die Liste leer, wird jeder gesetzte Origin abgelehnt.
 */
function originAllowed(origin: string | undefined, allowed: string[]): boolean {
  if (origin === undefined) return true;
  return allowed.includes(origin);
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    // Buffers are collected and decoded once at the end: appending each chunk to a
    // string decodes it in isolation, so any multi-byte UTF-8 character straddling a
    // chunk boundary is replaced by U+FFFD (umlauts/emoji in note bodies get mangled).
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;
    req.on("data", (c: Buffer) => {
      size += c.length;
      if (tooLarge) return; // weiterlesen, aber nicht mehr puffern
      if (size > limitBytes) {
        // Begrenzt wird der SPEICHER, nicht die Verbindung. Ein req.destroy() hier reißt den Socket
        // ab, während der Client noch sendet — er sieht dann ECONNRESET statt der 413-Antwort und
        // erfährt nie, warum. Also: aufhören zu puffern, den Rest verwerfen, sauber antworten.
        tooLarge = true;
        chunks.length = 0;
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (tooLarge) return reject(new Error("payload too large"));
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", reject);
    // Notbremse: ein Client, der nach dem Limit einfach weitersendet, darf nicht unbegrenzt
    // Bandbreite binden. Ab dem Zehnfachen wird die Verbindung doch gekappt.
    req.on("data", () => {
      if (tooLarge && size > limitBytes * 10) req.destroy();
    });
  });
}

async function dispatch(rpc: any, ctx: AuthContext, deps: Deps, requestId: string, ip?: string): Promise<unknown> {
  const { store, audit } = deps;
  const id = rpc?.id;
  const method = rpc?.method;

  if (method === "initialize") {
    return rpcResult(id, {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "mcp-showcase-server", version: "0.2.0" },
    });
  }

  if (method === "tools/list") {
    return rpcResult(id, {
      tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
    });
  }

  if (method === "tools/call") {
    const name = rpc?.params?.name;
    const args = (rpc?.params?.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOL_MAP.get(name);
    if (!tool) {
      await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, outcome: "error", code: "unknown_tool", requestId, ip });
      return rpcError(id, -32601, `Unknown tool: ${name}`);
    }
    try {
      const result = await tool.handler(args, ctx, store);
      await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, params: Object.keys(args), outcome: "ok", requestId, ip });
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (err) {
      if (err instanceof AuthError) {
        await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, params: Object.keys(args), outcome: "denied", code: err.code, requestId, ip });
        return rpcError(id, -32003, err.code === "insufficient_scope" ? "Insufficient scope" : "Access denied");
      }
      if (err instanceof ToolInputError) {
        await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, params: Object.keys(args), outcome: "error", code: "bad_input", requestId, ip });
        return rpcError(id, -32602, err.message);
      }
      // Generische Fehlermeldung nach außen — keine Interna/Stacktraces leaken.
      console.error(`[${requestId}] tool error:`, err);
      await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, outcome: "error", code: "internal", requestId, ip });
      return rpcError(id, -32603, "Internal error");
    }
  }

  if (typeof method === "string" && method.startsWith("notifications/")) {
    return undefined; // Notifications: kein Response-Body.
  }

  return rpcError(id, -32601, `Method not found: ${method}`);
}

export function buildServer(deps: Deps) {
  const { cfg, audit, limiter, verify } = deps;
  const httpsPublic = cfg.resourceUrl.startsWith("https:");

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const ip = req.socket.remoteAddress ?? undefined;
    const url = new URL(req.url ?? "/", cfg.resourceUrl);

    // Baseline-Sicherheits-Header auf jeder Antwort (überleben writeHead via setHeader).
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (httpsPublic) res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");

    // --- Discovery-Endpunkte (unauth, öffentlich) ---
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return json(res, 200, protectedResourceMetadata(cfg));
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { status: "ok" });
    }

    // --- Nur POST auf den MCP-Endpunkt ---
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      return json(res, 404, { error: "not_found" });
    }

    // --- Origin-Validierung (vor der Auth: die Herkunft entscheidet, nicht der Token) ---
    const origin = req.headers["origin"];
    if (typeof origin === "string" && !originAllowed(origin, cfg.allowedOrigins)) {
      await audit.write({ event: "origin", outcome: "denied", code: "origin_not_allowed", requestId, ip });
      return json(res, 403, { error: "origin_not_allowed" });
    }

    // --- Auth (OAuth 2.1 Bearer) ---
    let ctx: AuthContext;
    try {
      ctx = await verify(req.headers["authorization"]);
    } catch (err) {
      const code = err instanceof AuthError ? err.code : "invalid_token";
      await audit.write({ event: "auth", outcome: "denied", code, requestId, ip });
      // WWW-Authenticate mit Verweis auf Resource-Metadaten (RFC 9728 Stil).
      return json(res, 401, { error: code }, {
        "www-authenticate": `Bearer realm="mcp", error="${code}", resource_metadata="${cfg.resourceUrl}/.well-known/oauth-protected-resource"`,
      });
    }

    // --- Rate-Limit pro Tenant ---
    const rl = limiter.check(ctx.tenant);
    if (!rl.allowed) {
      await audit.write({ event: "rate_limit", subject: ctx.subject, tenant: ctx.tenant, outcome: "denied", code: "rate_limited", requestId, ip });
      return json(res, 429, { error: "rate_limited" }, { "retry-after": String(Math.ceil(rl.resetMs / 1000)) });
    }

    // --- Body + Dispatch ---
    let raw: string;
    try {
      raw = await readBody(req);
    } catch (err) {
      // Ein zu großer Body ist kein Parse-Fehler — das als -32700 zu melden schickte den Aufrufer
      // auf die Suche nach einem Syntaxfehler in wohlgeformtem JSON.
      const tooLarge = err instanceof Error && err.message === "payload too large";
      if (tooLarge) {
        return json(res, 413, rpcError(null, -32600, "Payload too large"), { connection: "close" });
      }
      return json(res, 400, rpcError(null, -32700, "Parse error"));
    }
    let rpc: any;
    try {
      rpc = JSON.parse(raw || "{}");
    } catch {
      return json(res, 400, rpcError(null, -32700, "Parse error"));
    }

    const out = await dispatch(rpc, ctx, deps, requestId, ip);
    if (out === undefined) {
      res.writeHead(202); // Notification akzeptiert.
      return res.end();
    }
    return json(res, 200, out, { "x-request-id": requestId });
  });
}
