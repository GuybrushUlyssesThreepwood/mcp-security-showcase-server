// Beweist: strukturiertes, append-only Audit-Log mit Secret-Redaktion.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { AuditLog } from "../src/audit.js";

function tmpPath(): string {
  return join(tmpdir(), `audit-test-${randomUUID()}.jsonl`);
}

test("writes append-only JSON Lines with a timestamp", async () => {
  const path = tmpPath();
  try {
    const log = new AuditLog(path);
    await log.write({ event: "auth", outcome: "denied", code: "missing_token" });
    await log.write({ event: "tool_call", tenant: "acme", tool: "list_notes", outcome: "ok" });

    const lines = (await readFile(path, "utf8")).trim().split("\n");
    assert.equal(lines.length, 2); // append-only: beide Zeilen erhalten
    const first = JSON.parse(lines[0]);
    const second = JSON.parse(lines[1]);
    assert.equal(first.event, "auth");
    assert.equal(first.outcome, "denied");
    assert.equal(typeof first.ts, "string");
    assert.equal(second.tool, "list_notes");
  } finally {
    await rm(path, { force: true });
  }
});

test("redacts secret-bearing param keys (top-level and nested)", async () => {
  const path = tmpPath();
  try {
    const log = new AuditLog(path);
    await log.write({
      event: "tool_call",
      outcome: "ok",
      params: {
        authorization: "Bearer super-secret-token",
        title: "harmless",
        nested: { password: "hunter2", api_key: "abc123", note: "keep" },
      },
    });
    const entry = JSON.parse((await readFile(path, "utf8")).trim());
    assert.equal(entry.params.authorization, "[redacted]");
    assert.equal(entry.params.title, "harmless");
    assert.equal(entry.params.nested.password, "[redacted]");
    assert.equal(entry.params.nested.api_key, "[redacted]");
    assert.equal(entry.params.nested.note, "keep");
  } finally {
    await rm(path, { force: true });
  }
});

test("truncates over-long string params", async () => {
  const path = tmpPath();
  try {
    const log = new AuditLog(path);
    await log.write({ event: "tool_call", outcome: "ok", params: { body: "x".repeat(1000) } });
    const entry = JSON.parse((await readFile(path, "utf8")).trim());
    assert.equal(entry.params.body.endsWith("…"), true);
    assert.equal(entry.params.body.length <= 513, true);
  } finally {
    await rm(path, { force: true });
  }
});
