// Mandantengetrennter Datenspeicher (In-Memory-Referenz).
// Kernprinzip: JEDE Operation ist auf tenant gescoped. Es gibt KEINE API, die tenant-übergreifend liest.
// Ein echtes Backend (Postgres mit Row-Level-Security etc.) ersetzt diese Klasse 1:1 — die Signaturen
// erzwingen tenant als erstes Argument.

import { randomUUID } from "node:crypto";

export interface Note {
  id: string;
  tenant: string;
  title: string;
  body: string;
  createdAt: string;
  createdBy: string;
}

/** Store-Vertrag: tenant ist IMMER erstes Argument → kein tenant-übergreifender Zugriff möglich.
 *  In-Memory (unten) und Postgres-RLS (store-pg.ts) implementieren beide dieses Interface. */
export interface Store {
  listNotes(tenant: string): Promise<Note[]> | Note[];
  getNote(tenant: string, id: string): Promise<Note | undefined> | Note | undefined;
  createNote(tenant: string, subject: string, title: string, body: string): Promise<Note> | Note;
}

export class TenantStore implements Store {
  // Map<tenant, Map<noteId, Note>> — physische Trennung pro Tenant.
  private byTenant = new Map<string, Map<string, Note>>();

  private tenantMap(tenant: string): Map<string, Note> {
    let m = this.byTenant.get(tenant);
    if (!m) {
      m = new Map();
      this.byTenant.set(tenant, m);
    }
    return m;
  }

  listNotes(tenant: string): Note[] {
    return [...this.tenantMap(tenant).values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  getNote(tenant: string, id: string): Note | undefined {
    // Lookup ausschließlich in der Tenant-Partition — ein fremder id trifft nichts.
    return this.tenantMap(tenant).get(id);
  }

  createNote(tenant: string, subject: string, title: string, body: string): Note {
    const note: Note = {
      id: randomUUID(),
      tenant,
      title,
      body,
      createdAt: new Date().toISOString(),
      createdBy: subject,
    };
    this.tenantMap(tenant).set(note.id, note);
    return note;
  }

  /** Nur für Tests/Seeds. */
  seed(notes: Array<Omit<Note, "id" | "createdAt">>): void {
    for (const n of notes) {
      const note: Note = { ...n, id: randomUUID(), createdAt: new Date().toISOString() };
      this.tenantMap(n.tenant).set(note.id, note);
    }
  }
}
