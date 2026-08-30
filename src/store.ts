// Tenant-separated data store (in-memory reference).
// Core principle: EVERY operation is scoped to a tenant. There is NO API that reads across tenants.
// A real backend (Postgres with row-level security, etc.) replaces this class one to one — the
// signatures force tenant to be the first argument.

import { randomUUID } from "node:crypto";

export interface Note {
  id: string;
  tenant: string;
  title: string;
  body: string;
  createdAt: string;
  createdBy: string;
}

/** Store contract: tenant is ALWAYS the first argument -> no cross-tenant access is expressible.
 *  The in-memory store (below) and Postgres RLS (store-pg.ts) both implement this interface. */
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
    // Look up only inside the tenant partition — a foreign id matches nothing.
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

  /** For tests and seeds only. */
  seed(notes: Array<Omit<Note, "id" | "createdAt">>): void {
    for (const n of notes) {
      const note: Note = { ...n, id: randomUUID(), createdAt: new Date().toISOString() };
      this.tenantMap(n.tenant).set(note.id, note);
    }
  }
}
