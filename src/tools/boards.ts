import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { LAYOUTS, PALETTE, SHAPE_TYPES } from "@/be/primitives/boards/elements";
import {
  addBoardElements,
  createBoard,
  getBoard,
  listBoards,
  removeBoardElements,
  updateBoardElements,
} from "@/be/primitives/boards/service";
import { objectOutputSchema, refusing } from "@/tools/objects";
import { createToolRegistrar, swarmToolOutputSchema, toolOk } from "@/tools/utils";

const Coord = z.number().min(-1_000_000).max(1_000_000);
const Size = z.number().positive().max(10_000);
const Color = z
  .string()
  .max(32)
  .describe(`A palette name (${Object.keys(PALETTE).join(", ")}) or #rrggbb (background).`);

const ShapeSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(64)
    .optional()
    .describe("Your name for the shape, so arrows in the same call can point at it."),
  type: z.enum(SHAPE_TYPES),
  x: Coord.optional(),
  y: Coord.optional(),
  width: Size.optional().describe("Minimum width; a shape grows to fit its label."),
  height: Size.optional().describe("Minimum height; a shape grows to fit its label."),
  label: z.string().max(2000).optional().describe("Text inside the shape; required for `text`."),
  color: Color.optional(),
});

const ArrowSchema = z.object({
  from: z
    .string()
    .min(1)
    .max(64)
    .describe("A shape `key` from this call or an existing element id."),
  to: z.string().min(1).max(64).describe("A shape `key` from this call or an existing element id."),
  label: z.string().max(500).optional(),
});

const Shapes = z.array(ShapeSchema).max(200).optional();
const Arrows = z.array(ArrowSchema).max(200).optional();
const LayoutSchema = z
  .enum(LAYOUTS)
  .optional()
  .describe("How shapes without x/y are placed, below existing content. Default `row`.");
const IdOrPath = {
  id: z.string().min(1).optional().describe("Board object id."),
  path: z.string().min(1).optional().describe("Board path on your default drive."),
};

const boardOut = {
  yourAgentId: z.string().optional(),
  object: objectOutputSchema.optional(),
  version: z.number().nullable().optional(),
};
const Added = z.record(z.string(), z.string());

const where = (o: { path: string; link: string | null }) =>
  `${o.path}${o.link ? ` (${o.link})` : ""}`;

export const registerBoardCreateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "board-create",
    {
      title: "Create board",
      annotations: { readOnlyHint: false, idempotentHint: false },
      description:
        "Create an Excalidraw board (`.excalidraw`) on your default agent-fs drive, as your own agent-fs identity, optionally with shapes and bound arrows. Create-only: refuses when the path exists. `added` maps each shape key (or `shapes[i]`) and `arrows[i]` to its element id.",
      inputSchema: z.object({
        path: z.string().min(1).describe("Drive path ending in .excalidraw."),
        title: z.string().max(200).optional(),
        shapes: Shapes,
        arrows: Arrows,
        layout: LayoutSchema,
      }),
      outputSchema: swarmToolOutputSchema({ ...boardOut, added: Added.optional() }),
    },
    async (args, requestInfo) => {
      const agentId = requestInfo.agentId;
      const result = await refusing(agentId, () => createBoard({ agentId, ...args }));
      if ("error" in result) return result.error;
      const { object, added } = result.value;
      return toolOk(`Created board ${object.id} at ${where(object)}.`, {
        data: { yourAgentId: agentId, object, version: object.fileVersion, added },
      });
    },
  );
};

export const registerBoardGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "board-get",
    {
      title: "Get board",
      annotations: { readOnlyHint: true },
      description:
        "Read a board by `id` or `path`. `detail: summary` (default) lists live elements as id, type, text, x, y, width, height and boundTo (arrow: [from, to]; shape: its arrow ids); a shape's label folds into its text. `detail: full` returns the raw Excalidraw elements.",
      inputSchema: z.object({
        ...IdOrPath,
        detail: z.enum(["summary", "full"]).optional(),
      }),
      outputSchema: swarmToolOutputSchema({
        ...boardOut,
        elements: z.array(z.looseObject({})).optional(),
      }),
    },
    async (args, requestInfo) => {
      const agentId = requestInfo.agentId;
      const result = await refusing(agentId, () => getBoard({ agentId, ...args }));
      if ("error" in result) return result.error;
      const { object, version, elements } = result.value;
      return toolOk(
        `Board ${object.id} at ${where(object)}: ${elements.length} elements, version ${version}.`,
        {
          data: { yourAgentId: agentId, object, version, elements },
        },
      );
    },
  );
};

export const registerBoardListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "board-list",
    {
      title: "List boards",
      annotations: { readOnlyHint: true },
      description:
        "List boards on your default agent-fs drive, newest first. Filter by path `prefix`. Pagination via limit (max 200) and offset.",
      inputSchema: z.object({
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
    async (args, requestInfo) => {
      const agentId = requestInfo.agentId;
      const result = await refusing(agentId, () => listBoards({ agentId, ...args }));
      if ("error" in result) return result.error;
      const { objects, total } = result.value;
      return toolOk(`Found ${objects.length} of ${total} boards.`, {
        details:
          objects.length > 0
            ? objects.map((o) => `- ${o.id} at ${where(o)}`).join("\n")
            : undefined,
        data: { yourAgentId: agentId, objects, total },
      });
    },
  );
};

export const registerBoardAddElementsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "board-add-elements",
    {
      title: "Add board elements",
      annotations: { readOnlyHint: false, idempotentHint: false },
      description:
        "Add shapes (rectangle, ellipse, diamond, text) and arrows to a board. Arrows bind both ends to shapes, named by a `key` from this call or an existing element id. Shapes without x/y are laid out below existing content. Writes with the file version and re-applies on a concurrent change (3 retries).",
      inputSchema: z.object({ ...IdOrPath, shapes: Shapes, arrows: Arrows, layout: LayoutSchema }),
      outputSchema: swarmToolOutputSchema({ ...boardOut, added: Added.optional() }),
    },
    async (args, requestInfo) => {
      const agentId = requestInfo.agentId;
      const result = await refusing(agentId, () => addBoardElements({ agentId, ...args }));
      if ("error" in result) return result.error;
      const { object, version, added } = result.value;
      return toolOk(
        `Added ${Object.keys(added).length} elements to board ${object.id}, version ${version}.`,
        {
          data: { yourAgentId: agentId, object, version, added },
        },
      );
    },
  );
};

export const registerBoardUpdateElementsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "board-update-elements",
    {
      title: "Update board elements",
      annotations: { readOnlyHint: false, idempotentHint: true },
      description:
        "Patch board elements by id: label (empty string removes a shape's label), x, y, width, height, color. Bound labels and arrows follow; arrows themselves take only label and color. Each touched element gets a new version, so an open editor repaints it.",
      inputSchema: z.object({
        ...IdOrPath,
        patches: z
          .array(
            z.object({
              elementId: z.string().min(1),
              label: z.string().max(2000).optional(),
              x: Coord.optional(),
              y: Coord.optional(),
              width: Size.optional(),
              height: Size.optional(),
              color: Color.optional(),
            }),
          )
          .min(1)
          .max(200),
      }),
      outputSchema: swarmToolOutputSchema({ ...boardOut, updated: z.array(z.string()).optional() }),
    },
    async (args, requestInfo) => {
      const agentId = requestInfo.agentId;
      const result = await refusing(agentId, () => updateBoardElements({ agentId, ...args }));
      if ("error" in result) return result.error;
      const { object, version, updated } = result.value;
      return toolOk(
        `Updated ${updated.length} elements on board ${object.id}, version ${version}.`,
        {
          data: { yourAgentId: agentId, object, version, updated },
        },
      );
    },
  );
};

export const registerBoardRemoveElementsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "board-remove-elements",
    {
      title: "Remove board elements",
      annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: true },
      description:
        "Remove board elements by id (sets `isDeleted: true`, the Excalidraw convention). A shape's label goes with it and its arrows are unbound; a removed arrow leaves its shapes. Refuses unknown ids before writing.",
      inputSchema: z.object({
        ...IdOrPath,
        elementIds: z.array(z.string().min(1)).min(1).max(500),
      }),
      outputSchema: swarmToolOutputSchema({ ...boardOut, removed: z.array(z.string()).optional() }),
    },
    async (args, requestInfo) => {
      const agentId = requestInfo.agentId;
      const result = await refusing(agentId, () => removeBoardElements({ agentId, ...args }));
      if ("error" in result) return result.error;
      const { object, version, removed } = result.value;
      return toolOk(
        `Removed ${removed.length} elements from board ${object.id}, version ${version}.`,
        {
          data: { yourAgentId: agentId, object, version, removed },
        },
      );
    },
  );
};
