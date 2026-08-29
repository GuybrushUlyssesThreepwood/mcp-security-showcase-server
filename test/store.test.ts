// Beweist die zentrale Sicherheitszusage: strikte Mandantentrennung im Store.
// Kein Zugriffspfad darf Daten eines fremden Tenants zurückgeben.

import { test } from "node:test";
import assert from "node:assert/strict";
import { TenantStore } from "../src/store.js";

test("createNote scopes the note to its tenant", () => {
  const store = new TenantStore();
  const note = store.createNote("acme", "user@acme", "Roadmap", "Q3 launch");
  assert.equal(note.tenant, "acme");
  assert.equal(note.createdBy, "user@acme");
  assert.equal(typeof note.id, "string");
  assert.equal(note.id.length > 0, true);
});

test("listNotes returns only the calling tenant's notes", () => {
  const store = new TenantStore();
  store.createNote("acme", "u", "A1", "x");
  store.createNote("acme", "u", "A2", "y");
  store.createNote("globex", "u", "G1", "z");

  const acme = store.listNotes("acme");
  const globex = store.listNotes("globex");
  assert.equal(acme.length, 2);
  assert.equal(globex.length, 1);
  assert.deepEqual(acme.map((n) => n.title).sort(), ["A1", "A2"]);
  assert.deepEqual(globex.map((n) => n.title), ["G1"]);
});

test("getNote across tenants returns undefined (no cross-tenant read, no existence leak)", () => {
  const store = new TenantStore();
  const acmeNote = store.createNote("acme", "u", "Secret", "top secret");

  // Selber Tenant: findbar.
  assert.equal(store.getNote("acme", acmeNote.id)?.title, "Secret");
  // Fremder Tenant mit dem echten (existierenden!) id: nichts — identisch zu "existiert nicht".
  assert.equal(store.getNote("globex", acmeNote.id), undefined);
});

test("an unknown tenant sees an empty store, never another tenant's data", () => {
  const store = new TenantStore();
  store.createNote("acme", "u", "A", "x");
  assert.deepEqual(store.listNotes("never-seen"), []);
});

test("seed keeps tenant partitioning", () => {
  const store = new TenantStore();
  store.seed([
    { tenant: "acme", title: "A", body: "x", createdBy: "seed" },
    { tenant: "globex", title: "G", body: "y", createdBy: "seed" },
  ]);
  assert.equal(store.listNotes("acme").length, 1);
  assert.equal(store.listNotes("globex").length, 1);
  assert.equal(store.listNotes("acme")[0].tenant, "acme");
});
