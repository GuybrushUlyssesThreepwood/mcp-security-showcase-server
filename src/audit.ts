// Strukturiertes, append-only Audit-Log (JSON Lines).
// Protokolliert: wer (subject) · welcher Tenant · welches Tool · Parameter (redigiert) · Ergebnis · Zeit.
// Secrets/PII werden vor dem Schreiben redigiert.

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
