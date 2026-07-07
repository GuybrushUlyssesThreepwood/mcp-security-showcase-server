// HTTP-Layer: MCP-über-Streamable-HTTP als OAuth-2.1-Resource-Server.
// Bewusst explizit (kein Framework), damit die Security-Schichten sichtbar sind — der Verkaufspunkt.
// Reihenfolge pro Request: TLS-Hinweis · Auth · Rate-Limit · Dispatch · Audit.

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
    // Restriktives CORS: keine Wildcard mit Credentials. Tokenbasiert, kein Origin-Reflect.
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}
function rpcResult(id: unknown, result: unknown) {
  return { jsonrpc: "2.0", id: id ?? null, result };
}

async function readBody(req: IncomingMessage, limitBytes = 1_000_000): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
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
      serverInfo: { name: "mcp-showcase-server", version: "0.1.0" },
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
      await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, params: args, outcome: "ok", requestId, ip });
      return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result });
    } catch (err) {
      if (err instanceof AuthError) {
        await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, params: args, outcome: "denied", code: err.code, requestId, ip });
        return rpcError(id, -32003, err.code === "insufficient_scope" ? "Insufficient scope" : "Access denied");
      }
      if (err instanceof ToolInputError) {
        await audit.write({ event: "tool_call", subject: ctx.subject, tenant: ctx.tenant, tool: name, params: args, outcome: "error", code: "bad_input", requestId, ip });
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

  return createServer(async (req, res) => {
    const requestId = randomUUID();
    const ip = req.socket.remoteAddress ?? undefined;
    const url = new URL(req.url ?? "/", cfg.resourceUrl);

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
    let rpc: any;
    try {
      const raw = await readBody(req);
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
