import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import {
  createObject,
  getObject,
  listObjects,
  ObjectsError,
  PRIMITIVE_KIND_NAMES,
  type PrimitiveObject,
  reindexObjects,
} from "@/be/primitives/objects";
import { FilesError } from "@/fs/provider";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

// Loose, format-pin-free mirror of PrimitiveObject for MCP output validation.
export const objectOutputSchema = z.looseObject({
  id: z.string().optional(),
  kind: z.string().optional(),
  orgId: z.string().optional(),
  driveId: z.string().optional(),
  path: z.string().optional(),
  title: z.string().nullable().optional(),
  fileVersion: z.number().nullable().optional(),
  ownerAgentId: z.string().nullable().optional(),
  deletedAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  link: z.string().nullable().optional(),
});

const KindSchema = z.enum(PRIMITIVE_KIND_NAMES);

/** Refusals (bad input, no agent-fs identity, agent-fs errors) become toolErr; bugs still throw. */
export async function refusing<T>(
  agentId: string | undefined,
  run: () => Promise<T>,
): Promise<{ value: T } | { error: ReturnType<typeof toolErr> }> {
  try {
    return { value: await run() };
  } catch (error) {
    if (error instanceof ObjectsError || error instanceof FilesError) {
      return { error: toolErr(error.message, { data: { yourAgentId: agentId } }) };
    }
    throw error;
  }
}

const summary = (o: PrimitiveObject) =>
  `${o.kind} ${o.id} at ${o.path}${o.link ? ` (${o.link})` : ""}`;

export const registerObjectCreateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "object-create",
    {
      title: "Create primitive object",
      annotations: { readOnlyHint: false, idempotentHint: false },
      description:
        "Create a primitive object file on your default agent-fs drive, as your own agent-fs identity, and give it a stable id. Create-only: refuses when the path exists (use object-reindex to adopt an existing file). Kind `board` writes an empty Excalidraw scene and needs a `.excalidraw` path. Kind `sheet` writes an empty `swarm-sheet/1` workbook and needs a `.sheet.json` path (edit it with the sheet-* tools).",
      inputSchema: z.object({
        kind: KindSchema.describe(
          "Object kind. `board`: an Excalidraw scene (.excalidraw). `sheet`: a spreadsheet (.sheet.json).",
        ),
        path: z.string().min(1).describe("Drive path, e.g. /boards/roadmap.excalidraw."),
        title: z.string().max(200).optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        object: objectOutputSchema.optional(),
      }),
    },
    async ({ kind, path, title }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        createObject({ agentId: requestInfo.agentId, kind, path, title }),
      );
      if ("error" in result) return result.error;
      return toolOk(`Created ${summary(result.value)}.`, {
        data: { yourAgentId: requestInfo.agentId, object: result.value },
      });
    },
  );
};

export const registerObjectGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "object-get",
    {
      title: "Get primitive object",
      description:
        "Get a primitive object on your default agent-fs drive by `id` or `path`. `missing: true` means the row exists but the file is gone. `includeContent` returns the parsed file.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        id: z.string().min(1).optional(),
        path: z.string().min(1).optional(),
        includeContent: z.boolean().optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        object: objectOutputSchema.optional(),
        missing: z.boolean().optional(),
        content: z.unknown().optional(),
      }),
    },
    async ({ id, path, includeContent }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        getObject({ agentId: requestInfo.agentId, id, path, includeContent }),
      );
      if ("error" in result) return result.error;
      const { object, missing, content } = result.value;
      return toolOk(
        missing ? `File for ${summary(object)} is missing.` : `Found ${summary(object)}.`,
        {
          data: {
            yourAgentId: requestInfo.agentId,
            object,
            missing,
            ...(content === undefined ? {} : { content }),
          },
        },
      );
    },
  );
};

export const registerObjectListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "object-list",
    {
      title: "List primitive objects",
      description:
        "List primitive objects on your default agent-fs drive, newest first. Hides objects whose file agent-fs reported deleted. Filter by `kind` and path `prefix`. Pagination via limit (max 200) and offset.",
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        kind: KindSchema.optional(),
        prefix: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        objects: z.array(objectOutputSchema).optional(),
        total: z.number().optional(),
      }),
    },
    async ({ kind, prefix, limit, offset }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        listObjects({ agentId: requestInfo.agentId, kind, prefix, limit, offset }),
      );
      if ("error" in result) return result.error;
      const { objects, total } = result.value;
      return toolOk(`Found ${objects.length} of ${total} objects.`, {
        details: objects.length > 0 ? objects.map((o) => `- ${summary(o)}`).join("\n") : undefined,
        data: { yourAgentId: requestInfo.agentId, objects, total },
      });
    },
  );
};

export const registerObjectReindexTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "object-reindex",
    {
      title: "Reindex primitive objects",
      annotations: { readOnlyHint: false, idempotentHint: true },
      description:
        "Rebuild the object index from the files on your default agent-fs drive. Keeps each file's embedded id; a file with no id (for example a stock Excalidraw save) keeps the id of the row at its path, else gets a new one written back. Rows whose file is gone are reported as `missing`, never deleted. Files whose version matches the index are checked, not re-read (`unchanged`); one call reads at most 50 changed files, 16 MiB, or 20 seconds of work, so run it again while `truncated` is true (`cutBy` names the limit). agent-fs file.changed webhooks keep the index current between runs when the swarm can register them.",
      inputSchema: z.object({ kind: KindSchema.optional() }),
      outputSchema: swarmToolOutputSchema({
        yourAgentId: z.string().optional(),
        scanned: z.number().optional(),
        unchanged: z.number().optional(),
        adopted: z.array(z.string()).optional(),
        restored: z.array(z.string()).optional(),
        missing: z.array(z.string()).optional(),
        conflicts: z.array(z.looseObject({ path: z.string(), reason: z.string() })).optional(),
        truncated: z.boolean().optional(),
        cutBy: z.enum(["files", "reads", "time", "bytes"]).nullable().optional(),
      }),
    },
    async ({ kind }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        reindexObjects({ agentId: requestInfo.agentId, kind }),
      );
      if ("error" in result) return result.error;
      const report = result.value;
      return toolOk(
        `Scanned ${report.scanned} files: ${report.unchanged} unchanged, ${report.adopted.length} adopted, ${report.restored.length} restored, ${report.missing.length} missing, ${report.conflicts.length} skipped${report.truncated ? ` (truncated: ${report.cutBy} limit)` : ""}.`,
        { data: { yourAgentId: requestInfo.agentId, ...report } },
      );
    },
  );
};
