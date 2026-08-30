// Beweist auf Tool-Ebene: Scope-Erzwingung (least privilege) + Mandantentrennung + kein Existence-Leak.
// The AuthContext is built synthetically (no JWT needed) — exactly as the server passes it on after token verification.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TOOL_MAP, ToolInputError } from "../src/tools.js";
import { AuthError, type AuthContext } from "../src/auth.js";
import { TenantStore } from "../src/store.js";

function ctx(tenant: string, scopes: string[], subject = `user@${tenant}`): AuthContext {
  return { subject, tenant, scopes, raw: {} };
}

const listNotes = TOOL_MAP.get("list_notes")!;
const getNote = TOOL_MAP.get("get_note")!;
const createNote = TOOL_MAP.get("create_note")!;

test("create_note requires notes:write scope", async () => {
  const store = new TenantStore();
  await assert.rejects(
    () => createNote.handler({ title: "t", body: "b" }, ctx("acme", ["notes:read"]), store),
    (e: unknown) => e instanceof AuthError && e.code === "insufficient_scope"
  );
});

test("list_notes and get_note require notes:read scope", async () => {
  const store = new TenantStore();
  await assert.rejects(
    () => listNotes.handler({}, ctx("acme", ["notes:write"]), store),
    (e: unknown) => e instanceof AuthError && e.code === "insufficient_scope"
  );
  await assert.rejects(
    () => getNote.handler({ id: "whatever" }, ctx("acme", ["notes:write"]), store),
    (e: unknown) => e instanceof AuthError && e.code === "insufficient_scope"
  );
});

test("a tenant only ever sees its own notes via list_notes", async () => {
  const store = new TenantStore();
  await createNote.handler({ title: "Acme", body: "x" }, ctx("acme", ["notes:write"]), store);
  await createNote.handler({ title: "Globex", body: "y" }, ctx("globex", ["notes:write"]), store);

  const acmeList = (await listNotes.handler({}, ctx("acme", ["notes:read"]), store)) as { notes: unknown[] };
  assert.equal(acmeList.notes.length, 1);
  assert.equal((acmeList.notes[0] as { title: string }).title, "Acme");
});

test("get_note cannot read another tenant's note — returns 'not found' (no existence leak)", async () => {
  const store = new TenantStore();
  const created = (await createNote.handler(
    { title: "Secret", body: "top" },
    ctx("acme", ["notes:write"]),
    store
  )) as { id: string };

  // Selber Tenant: lesbar.
  const own = (await getNote.handler({ id: created.id }, ctx("acme", ["notes:read"]), store)) as {
    note: { title: string };
  };
  assert.equal(own.note.title, "Secret");

  // Fremder Tenant mit dem echten id: identischer Fehler wie "existiert nicht".
  await assert.rejects(
    () => getNote.handler({ id: created.id }, ctx("globex", ["notes:read"]), store),
    (e: unknown) => e instanceof ToolInputError && /not found/i.test((e as Error).message)
  );
});

test("get_note validates input (missing id)", async () => {
  const store = new TenantStore();
  await assert.rejects(
    () => getNote.handler({}, ctx("acme", ["notes:read"]), store),
    (e: unknown) => e instanceof ToolInputError
  );
});

test("create_note persists and is retrievable by the same tenant", async () => {
  const store = new TenantStore();
  const created = (await createNote.handler(
    { title: "Note", body: "content" },
    ctx("acme", ["notes:read", "notes:write"]),
    store
  )) as { id: string; createdAt: string };
  assert.equal(typeof created.id, "string");

  const got = (await getNote.handler({ id: created.id }, ctx("acme", ["notes:read"]), store)) as {
    note: { body: string; createdBy: string };
  };
  assert.equal(got.note.body, "content");
  assert.equal(got.note.createdBy, "user@acme");
});
