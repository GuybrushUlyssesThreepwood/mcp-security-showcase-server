// Postgres-Store mit Row-Level-Security (Roadmap-Umsetzung).
// Zwei Verteidigungslinien:
//   1) Jede Query filtert explizit nach tenant ($1).
//   2) Zusätzlich wird pro Transaktion `app.current_tenant` gesetzt; die RLS-Policy in
//      migrations/001_notes_rls.sql erzwingt tenant-Isolation auf DB-Ebene (auch bei App-Bug).
//
// `pg` ist eine optionale Abhängigkeit — nur nötig, wenn STORE=pg. Import daher dynamisch.

import { randomUUID } from "node:crypto";
import type { Note, Store } from "./store.js";

interface PgLike {
  connect(): Promise<PgClient>;
  end(): Promise<void>;
}
interface PgClient {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
  release(): void;
}

export class PgTenantStore implements Store {
  private constructor(private pool: PgLike) {}

  static async create(connectionString: string): Promise<PgTenantStore> {
    // Dynamischer Import: base-Server läuft ohne installiertes 'pg'.
    const pg = await import("pg").catch(() => {
      throw new Error("STORE=pg requires the 'pg' package. Run: npm install pg");
    });
    const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
    return new PgTenantStore(new Pool({ connectionString }));
  }

  /** Führt fn in einer Transaktion aus, in der app.current_tenant gesetzt ist (für RLS). */
  private async withTenant<T>(tenant: string, fn: (c: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // set_config(..., true) = nur für diese Transaktion (LOCAL).
      await client.query("SELECT set_config('app.current_tenant', $1, true)", [tenant]);
      const out = await fn(client);
      await client.query("COMMIT");
      return out;
    } catch (err) {
      await client.query("ROLLBACK").catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  private static toNote(r: any): Note {
    return {
      id: r.id,
      tenant: r.tenant,
      title: r.title,
      body: r.body,
      createdAt: (r.created_at instanceof Date ? r.created_at.toISOString() : String(r.created_at)),
      createdBy: r.created_by,
    };
  }

  async listNotes(tenant: string): Promise<Note[]> {
    return this.withTenant(tenant, async (c) => {
      const { rows } = await c.query(
        "SELECT id, tenant, title, body, created_at, created_by FROM notes WHERE tenant = $1 ORDER BY created_at",
        [tenant]
      );
      return rows.map(PgTenantStore.toNote);
    });
  }

  async getNote(tenant: string, id: string): Promise<Note | undefined> {
    return this.withTenant(tenant, async (c) => {
      const { rows } = await c.query(
        "SELECT id, tenant, title, body, created_at, created_by FROM notes WHERE tenant = $1 AND id = $2",
        [tenant, id]
      );
      return rows[0] ? PgTenantStore.toNote(rows[0]) : undefined;
    });
  }

  async createNote(tenant: string, subject: string, title: string, body: string): Promise<Note> {
    const id = randomUUID();
    return this.withTenant(tenant, async (c) => {
      const { rows } = await c.query(
        `INSERT INTO notes (id, tenant, title, body, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING id, tenant, title, body, created_at, created_by`,
        [id, tenant, title, body, subject]
      );
      return PgTenantStore.toNote(rows[0]);
    });
  }
}
