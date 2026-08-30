// Structured, append-only audit log (JSON Lines).
// Records: who (subject) - which tenant - which tool - which parameter NAMES - outcome - time.
//
// Deliberately without parameter values: note contents, titles and everything else a tool accepts
// do not belong in the audit log. An audit answers "who did what, when", not "what did it say" —
// and a log that copies user content becomes a data-protection problem of its own and passes its
// retention period on to other people's content.
//
// `redact` stays as a second line of defence: it masks values by key name and truncates long
// strings, in case a caller does pass an object instead of a list of names. It does NOT detect
// secrets by value — a token stored under the key `note` would survive.

import { appendFile } from "node:fs/promises";

export interface AuditEntry {
  ts: string;
  event: string;
  subject?: string;
  tenant?: string;
  tool?: string;
  params?: unknown;
  outcome: "ok" | "denied" | "error";
  code?: string;
  requestId?: string;
  ip?: string;
}

const SECRET_KEYS = /^(authorization|token|password|secret|api[_-]?key|access_token|refresh_token)$/i;

function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[deep]";
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_KEYS.test(k) ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 512) return value.slice(0, 512) + "…";
  return value;
}

export class AuditLog {
  constructor(private path: string) {}

  /**
   * Check once at start-up whether writing is possible at all.
   *
   * `write` swallows errors on purpose, so a full disk does not kill requests. The price: a
   * permanently unwritable path (wrong permissions in the container) would otherwise never surface
   * — the server runs, just without an audit trail. That is exactly the state that must not exist.
   */
  async assertWritable(): Promise<void> {
    try {
      await appendFile(this.path, "", "utf8");
    } catch (err) {
      throw new Error(
        `Audit log is not writable at '${this.path}': ${err instanceof Error ? err.message : err}. ` +
          `Refusing to start — a server without an audit trail is not the server this repo demonstrates.`
      );
    }
  }

  async write(entry: Omit<AuditEntry, "ts">): Promise<void> {
    const line: AuditEntry = {
      ts: new Date().toISOString(),
      ...entry,
      params: entry.params === undefined ? undefined : redact(entry.params),
    };
    try {
      await appendFile(this.path, JSON.stringify(line) + "\n", "utf8");
    } catch (err) {
      // Audit darf den Request nicht crashen, aber der Fehler muss sichtbar sein.
      console.error("[audit] write failed:", err instanceof Error ? err.message : err);
    }
  }
}
