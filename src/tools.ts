// Tool-Definitionen. Jeder Handler ist tenant-gescoped und scope-geprüft.
// Beschreibungen sind bewusst neutral/sauber (kein Injection-Material) — der Scanner läuft grün durch.

import type { AuthContext } from "./auth.js";
import { requireScope } from "./auth.js";
import type { TenantStore } from "./store.js";

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler(args: Record<string, unknown>, ctx: AuthContext, store: TenantStore): Promise<unknown>;
}

function str(args: Record<string, unknown>, key: string, required = true): string {
  const v = args[key];
  if (typeof v !== "string" || (required && v.length === 0)) {
    throw new ToolInputError(`Parameter '${key}' must be a non-empty string`);
  }
  return (v as string) ?? "";
}

export class ToolInputError extends Error {}

export const TOOLS: ToolDef[] = [
  {
    name: "list_notes",
    description: "List all notes belonging to the authenticated tenant.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    async handler(_args, ctx, store) {
      requireScope(ctx, "notes:read");
      const notes = store.listNotes(ctx.tenant);
      return { notes: notes.map(({ id, title, createdAt }) => ({ id, title, createdAt })) };
    },
  },
  {
    name: "get_note",
    description: "Get a single note by id. Only notes of the authenticated tenant are accessible.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Note id" } },
      required: ["id"],
      additionalProperties: false,
    },
    async handler(args, ctx, store) {
      requireScope(ctx, "notes:read");
      const id = str(args, "id");
      const note = store.getNote(ctx.tenant, id);
      if (!note) {
        // Kein Unterschied zwischen "fremder Tenant" und "existiert nicht" → keine Cross-Tenant-Info.
        throw new ToolInputError("Note not found");
      }
      return { note };
    },
  },
  {
    name: "create_note",
    description: "Create a note for the authenticated tenant.",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Note title" },
        body: { type: "string", description: "Note body" },
      },
      required: ["title", "body"],
      additionalProperties: false,
    },
    async handler(args, ctx, store) {
      requireScope(ctx, "notes:write");
      const title = str(args, "title");
      const body = str(args, "body");
      const note = store.createNote(ctx.tenant, ctx.subject, title, body);
      return { id: note.id, createdAt: note.createdAt };
    },
  },
];

export const TOOL_MAP = new Map(TOOLS.map((t) => [t.name, t]));
