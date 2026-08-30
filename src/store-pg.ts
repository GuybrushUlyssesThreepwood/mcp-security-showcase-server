// Postgres store with row-level security (roadmap item, implemented).
// Two lines of defence:
//   1) Every query filters explicitly by tenant ($1).
//   2) In addition, `app.current_tenant` is set per transaction; the RLS policy in
//      migrations/001_notes_rls.sql enforces tenant isolation at the database level (even with an
//      application bug).
//
// `pg` is an optional dependency — only needed when STORE=pg, so the import is dynamic.

import { randomUUID } from "node:crypto";
import type { Note, Store } from "./store.js";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
    // Dynamic import: the base server runs without 'pg' installed.
    const pg = await import("pg").catch(() => {
      throw new Error("STORE=pg requires the 'pg' package. Run: npm install pg");
    });
    const Pool = (pg as any).default?.Pool ?? (pg as any).Pool;
    return new PgTenantStore(new Pool({ connectionString }));
  }

  /** Runs fn inside a transaction in which app.current_tenant is set (for RLS). */
  private async withTenant<T>(tenant: string, fn: (c: PgClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // set_config(..., true) = for this transaction only (LOCAL).
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
    // `id` is a uuid column, so a non-uuid string makes Postgres raise
    // "invalid input syntax for type uuid" — that surfaced as a 500 Internal error
    // instead of the intended "Note not found", and the error text distinguished a
    // malformed id from a foreign one. Reject the shape before querying.
    if (!UUID_RE.test(id)) return undefined;
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
