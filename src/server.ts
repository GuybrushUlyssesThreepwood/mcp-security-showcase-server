// HTTP layer: MCP over Streamable HTTP as an OAuth 2.1 resource server.
// Deliberately explicit (no framework) so the security layers stay visible — that is the point.
// Order per request: security headers - origin - auth - rate limit - dispatch - audit.

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
    // Deliberately NO CORS headers: access is purely token-based and not intended for browser
    // cross-origin use. Without Access-Control-Allow-Origin the browser blocks the response —
    // that is the most restrictive setting available, not a forgotten header.
    "cache-control": "no-store",
    ...headers,
  });
  res.end(payload);
}

/**
 * Origin check against DNS rebinding (MCP Streamable HTTP: servers MUST validate the origin).
 *
 * Without it, any web page can address a server reachable locally or on an internal network via DNS
 * rebinding. The bearer token does not fully protect against that: what is checked here is where the
 * request came from, not who sent it.
 *
 * Non-browser clients (CLI, agent, server-to-server) send no Origin at all — those pass, because a
 * missing origin is not a cross-site context. Origins that are set must appear in ALLOWED_ORIGINS;
 * when that list is empty, every origin that is set is refused.
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
      if (tooLarge) return; // keep reading, but stop buffering
      if (size > limitBytes) {
        // What is bounded is MEMORY, not the connection. A req.destroy() here tears down the
        // socket while the client is still sending — it then sees ECONNRESET instead of the 413 and
        // never learns why. So: stop buffering, discard the rest, answer cleanly.
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
      serverInfo: { name: "mcp-showcase-server", version: "0.2.1" },
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
      // Generic error message outward — leak no internals or stack traces.
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

    // Baseline security headers on every response (they survive writeHead via setHeader).
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    if (httpsPublic) res.setHeader("strict-transport-security", "max-age=15552000; includeSubDomains");

    // --- Discovery endpoints (unauthenticated, public) ---
    if (req.method === "GET" && url.pathname === "/.well-known/oauth-protected-resource") {
      return json(res, 200, protectedResourceMetadata(cfg));
    }
    if (req.method === "GET" && url.pathname === "/healthz") {
      return json(res, 200, { status: "ok" });
    }

    // --- POST to the MCP endpoint only ---
    if (req.method !== "POST" || url.pathname !== "/mcp") {
      return json(res, 404, { error: "not_found" });
    }

    // --- Origin validation (before auth: origin decides, not the token) ---
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
      // WWW-Authenticate pointing at the resource metadata (RFC 9728 style).
      return json(res, 401, { error: code }, {
        "www-authenticate": `Bearer realm="mcp", error="${code}", resource_metadata="${cfg.resourceUrl}/.well-known/oauth-protected-resource"`,
      });
    }

    // --- Per-tenant rate limit ---
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
      // An oversized body is not a parse error — reporting it as -32700 sent callers looking for
      // a syntax error in well-formed JSON.
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
