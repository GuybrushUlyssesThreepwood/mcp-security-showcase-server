// Strukturiertes, append-only Audit-Log (JSON Lines).
// Protokolliert: wer (subject) · welcher Tenant · welches Tool · welche Parameter-NAMEN · Ergebnis · Zeit.
//
// Bewusst ohne Parameterwerte: Notizinhalte, Titel und alles andere, was ein Tool entgegennimmt,
// gehören nicht ins Audit-Log. Ein Audit beantwortet „wer hat wann was getan", nicht „was stand
// drin" — und ein Log, das Nutzerinhalte mitschreibt, wird selbst zum Datenschutzproblem und
// vererbt seine Aufbewahrungsfrist an fremde Inhalte.
//
// `redact` bleibt als zweite Verteidigungslinie: sie maskiert Werte anhand des Schlüsselnamens und
// kürzt lange Strings, falls ein Aufrufer doch einmal ein Objekt statt einer Namensliste übergibt.
// Sie erkennt KEINE Secrets am Wert — ein Token unter dem Schlüssel `note` bliebe stehen.

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
   * Einmal beim Start prüfen, ob überhaupt geschrieben werden kann.
   *
   * `write` fängt Fehler bewusst ab, damit ein volles Dateisystem keine Requests killt. Der Preis:
   * ein dauerhaft nicht schreibbarer Pfad (falsche Rechte im Container) fällt sonst nie auf — der
   * Server läuft, nur ohne Audit-Trail. Genau das ist der Zustand, den es nicht geben darf.
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
