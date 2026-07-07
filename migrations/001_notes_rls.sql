-- Notes table with tenant-scoped Row-Level-Security.
-- The application connects as a NON-superuser role (RLS does not apply to superusers/table owners
-- unless FORCE is set). We FORCE RLS so even the table owner is constrained.
--
-- The app sets `app.current_tenant` per transaction (see src/store-pg.ts). The policy compares each
-- row's tenant against that setting → a query can only ever see/insert its own tenant's rows,
-- even if the application code forgot a WHERE clause.

CREATE TABLE IF NOT EXISTS notes (
  id         uuid PRIMARY KEY,
  tenant     text NOT NULL,
  title      text NOT NULL,
  body       text NOT NULL,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_tenant_idx ON notes (tenant, created_at);

ALTER TABLE notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE notes FORCE ROW LEVEL SECURITY;

-- Visible rows: only those matching the current tenant setting.
DROP POLICY IF EXISTS notes_tenant_isolation ON notes;
CREATE POLICY notes_tenant_isolation ON notes
  USING (tenant = current_setting('app.current_tenant', true))
  WITH CHECK (tenant = current_setting('app.current_tenant', true));

-- Application role (least privilege: no DDL, just DML on this table).
-- Run once as admin, then point DATABASE_URL at this role:
--   CREATE ROLE mcp_app LOGIN PASSWORD '...';
--   GRANT SELECT, INSERT ON notes TO mcp_app;
