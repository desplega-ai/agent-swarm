import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { ObjectsError } from "@/be/primitives/objects";
import {
  addSheetTab,
  appendSheetRows,
  clearSheetRange,
  createSheet,
  exportSheetXlsx,
  getSheet,
  getSheetRange,
  importSheetXlsx,
  listSheets,
  setSheetRange,
} from "@/be/primitives/sheets/service";
import { FilesError } from "@/fs/provider";
import { createToolRegistrar, swarmToolOutputSchema, toolErr, toolOk } from "@/tools/utils";

// Loose, format-pin-free mirror of PrimitiveObject for MCP output validation.
const objectOutputSchema = z.looseObject({
  id: z.string().optional(),
  kind: z.string().optional(),
  path: z.string().optional(),
  title: z.string().nullable().optional(),
  fileVersion: z.number().nullable().optional(),
  link: z.string().nullable().optional(),
});

const CellValue = z.union([z.number(), z.string(), z.boolean(), z.null()]);
const Grid = z.array(z.array(CellValue));

const RANGE_HELP =
  "A1 range such as `Tasks!B2:C3`, `A1:C10` (first tab), `'My tab'!A:A` (whole column, capped to the used range) or `B2`.";

/** Refusals (bad input, no agent-fs identity, agent-fs errors) become toolErr; bugs still throw. */
async function refusing<T>(
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

const dataShape = {
  yourAgentId: z.string().optional(),
  object: objectOutputSchema.optional(),
  objects: z.array(objectOutputSchema).optional(),
  total: z.number().optional(),
  link: z.string().nullable().optional(),
  version: z.number().optional(),
  tabs: z.array(z.unknown()).optional(),
  range: z.string().optional(),
  values: z.array(z.array(z.unknown())).optional(),
  formulas: z.array(z.array(z.unknown())).optional(),
  changed: z.number().optional(),
  recalculated: z.number().optional(),
  cleared: z.number().optional(),
  path: z.string().optional(),
  dropped: z.array(z.string()).optional(),
};

const outputSchema = swarmToolOutputSchema(dataShape);

const ID = "Object id (from sheet-create or sheet-list).";
const PATH = "Drive path of the `.sheet.json` file, instead of `id`.";
const WRITE = { readOnlyHint: false, idempotentHint: false } as const;

export const registerSheetCreateTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-create",
    {
      title: "Create sheet",
      annotations: WRITE,
      description:
        "Create a spreadsheet (`swarm-sheet/1`, a `.sheet.json` file) on your default agent-fs drive, as your own agent-fs identity. Create-only: refuses when the path exists. Optional `tabs` name the tabs (default one tab `Sheet1`) and may seed each with `rows` from A1. Formulas recompute with a spreadsheet engine; limits: 20 tabs, 50,000 cells, 5 MiB.",
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Drive path ending in `.sheet.json`, e.g. /qa/tracker.sheet.json."),
        title: z.string().max(200).optional(),
        tabs: z
          .array(z.object({ name: z.string().min(1).max(31), rows: Grid.optional() }))
          .optional()
          .describe("Tabs to create, each with an optional `rows` grid written from A1."),
      }),
      outputSchema,
    },
    async ({ path, title, tabs }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        createSheet({ agentId: requestInfo.agentId, path, title, tabs }),
      );
      if ("error" in result) return result.error;
      const { object, link } = result.value;
      return toolOk(`Created sheet ${object.id} at ${object.path}${link ? ` (${link})` : ""}.`, {
        data: { yourAgentId: requestInfo.agentId, ...result.value },
      });
    },
  );
};

export const registerSheetGetTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-get",
    {
      title: "Get sheet",
      annotations: { readOnlyHint: true },
      description:
        "Get a sheet's object, current agent-fs `version` and its tabs (name, used rows and columns, frozen rows). Read cells with sheet-get-range.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
      }),
      outputSchema,
    },
    async ({ id, path }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        getSheet({ agentId: requestInfo.agentId, id, path }),
      );
      if ("error" in result) return result.error;
      const { object, tabs, version } = result.value;
      return toolOk(
        `Sheet ${object.id} at ${object.path}: ${tabs.length} tab(s), version ${version}.`,
        {
          data: { yourAgentId: requestInfo.agentId, ...result.value },
        },
      );
    },
  );
};

export const registerSheetListTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-list",
    {
      title: "List sheets",
      annotations: { readOnlyHint: true },
      description:
        "List sheets on your default agent-fs drive, newest first. Filter by path `prefix`. Pagination via limit (max 200) and offset.",
      inputSchema: z.object({
        prefix: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
      }),
      outputSchema,
    },
    async ({ prefix, limit, offset }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        listSheets({ agentId: requestInfo.agentId, prefix, limit, offset }),
      );
      if ("error" in result) return result.error;
      const { objects, total } = result.value;
      return toolOk(`Found ${objects.length} of ${total} sheets.`, {
        details:
          objects.length > 0 ? objects.map((o) => `- ${o.id} at ${o.path}`).join("\n") : undefined,
        data: { yourAgentId: requestInfo.agentId, ...result.value },
      });
    },
  );
};

export const registerSheetGetRangeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-get-range",
    {
      title: "Read sheet range",
      annotations: { readOnlyHint: true },
      description:
        "Read cached values from a range (at most 10,000 cells). Formula cells return their computed value; an error cell returns its error text such as `#DIV/0!`; spilled cells (SEQUENCE, UNIQUE, ...) are included. `formulas: true` also returns the formulas.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
        range: z.string().min(1).describe(RANGE_HELP),
        formulas: z
          .boolean()
          .optional()
          .describe(
            "Also return `formulas[][]`: the formula text where a cell has one, else the value.",
          ),
      }),
      outputSchema,
    },
    async ({ id, path, range, formulas }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        getSheetRange({ agentId: requestInfo.agentId, id, path, range, formulas }),
      );
      if ("error" in result) return result.error;
      return toolOk(`Read ${result.value.range} at version ${result.value.version}.`, {
        data: { yourAgentId: requestInfo.agentId, ...result.value },
      });
    },
  );
};

export const registerSheetSetRangeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-set-range",
    {
      title: "Write sheet range",
      annotations: WRITE,
      description:
        "Write a rectangle of `values` and recompute every formula. A string starting with `=` is a formula; start with `'=` to store literal text that begins with `=`; other strings stay text even when they look like numbers, so send numbers as numbers; null clears the cell. A single-cell `range` is the top-left corner; a larger `range` must match the values' size. Retries on a concurrent write: other cells merge, the same cell is last writer wins.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
        range: z.string().min(1).describe(RANGE_HELP),
        values: Grid.describe("Rows of cell values, all the same length (at most 10,000 cells)."),
      }),
      outputSchema,
    },
    async ({ id, path, range, values }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        setSheetRange({ agentId: requestInfo.agentId, id, path, range, values }),
      );
      if ("error" in result) return result.error;
      const r = result.value;
      return toolOk(
        `Wrote ${r.range}: ${r.changed} changed, ${r.recalculated} recalculated, version ${r.version}.`,
        { data: { yourAgentId: requestInfo.agentId, ...r } },
      );
    },
  );
};

export const registerSheetAppendRowsTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-append-rows",
    {
      title: "Append sheet rows",
      annotations: WRITE,
      description:
        "Append rows below the last used row of a tab, starting at column A. Same value rules as sheet-set-range; null skips a cell. Returns the range written.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
        tab: z.string().min(1).describe("Tab name."),
        rows: Grid.describe("Rows to append (at most 10,000 cells)."),
      }),
      outputSchema,
    },
    async ({ id, path, tab, rows }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        appendSheetRows({ agentId: requestInfo.agentId, id, path, tab, rows }),
      );
      if ("error" in result) return result.error;
      return toolOk(`Appended ${result.value.range}, version ${result.value.version}.`, {
        data: { yourAgentId: requestInfo.agentId, ...result.value },
      });
    },
  );
};

export const registerSheetClearRangeTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-clear-range",
    {
      title: "Clear sheet range",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
      description:
        "Clear the contents of a range and recompute dependents. A whole-column or whole-row range is capped to the used range. Spilled cells go when their anchor is cleared.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
        range: z.string().min(1).describe(RANGE_HELP),
      }),
      outputSchema,
    },
    async ({ id, path, range }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        clearSheetRange({ agentId: requestInfo.agentId, id, path, range }),
      );
      if ("error" in result) return result.error;
      const r = result.value;
      return toolOk(`Cleared ${r.cleared} cell(s) in ${r.range}, version ${r.version}.`, {
        data: { yourAgentId: requestInfo.agentId, ...r },
      });
    },
  );
};

export const registerSheetAddTabTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-add-tab",
    {
      title: "Add sheet tab",
      annotations: WRITE,
      description:
        "Add an empty tab (1-31 characters, none of `[]:*?/\\`), at the end or after the tab named `after`. A sheet holds at most 20 tabs.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
        name: z.string().min(1).max(31).describe("New tab name."),
        after: z.string().optional().describe("Insert after this tab; default: at the end."),
      }),
      outputSchema,
    },
    async ({ id, path, name, after }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        addSheetTab({ agentId: requestInfo.agentId, id, path, name, after }),
      );
      if ("error" in result) return result.error;
      return toolOk(
        `Tabs now: ${result.value.tabs.join(", ")} (version ${result.value.version}).`,
        {
          data: { yourAgentId: requestInfo.agentId, ...result.value },
        },
      );
    },
  );
};

const dropMessage = (dropped: string[]) =>
  dropped.length ? `Dropped: ${dropped.join(", ")}.` : "Nothing dropped.";

export const registerSheetImportXlsxTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-import-xlsx",
    {
      title: "Import xlsx as sheet",
      annotations: WRITE,
      description:
        "Import an `.xlsx` file from your default agent-fs drive as a new sheet, as your own agent-fs identity. Create-only: refuses when the sheet path exists. Keeps tabs, values, formulas (recomputed), number formats, column widths and merges. `dropped` lists what the file had that a sheet cannot hold (styles, charts, comments, frozen panes, and so on). Limits: 5 MiB file, 20 tabs, 50,000 cells; nothing is created when a limit refuses.",
      inputSchema: z.object({
        sourcePath: z.string().min(1).describe("Drive path of the `.xlsx` file to import."),
        path: z.string().min(1).describe("Drive path for the new sheet, ending in `.sheet.json`."),
        title: z.string().max(200).optional(),
      }),
      outputSchema,
    },
    async ({ sourcePath, path, title }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        importSheetXlsx({ agentId: requestInfo.agentId, sourcePath, path, title }),
      );
      if ("error" in result) return result.error;
      const { object, link, dropped } = result.value;
      return toolOk(
        `Imported ${sourcePath} as sheet ${object.id} at ${object.path}${link ? ` (${link})` : ""}. ${dropMessage(dropped)}`,
        { data: { yourAgentId: requestInfo.agentId, ...result.value } },
      );
    },
  );
};

export const registerSheetExportXlsxTool = (server: McpServer) => {
  createToolRegistrar(server)(
    "sheet-export-xlsx",
    {
      title: "Export sheet as xlsx",
      annotations: WRITE,
      description:
        "Export a sheet to an `.xlsx` file on your default agent-fs drive. Writes formulas with their cached values, number formats, column widths and merges. `dropped` lists what the file cannot carry (frozen panes, spilled array cells). Create-only: refuses when `targetPath` exists unless `overwrite` is true.",
      inputSchema: z.object({
        id: z.string().min(1).optional().describe(ID),
        path: z.string().min(1).optional().describe(PATH),
        targetPath: z.string().min(1).describe("Drive path for the new file, ending in `.xlsx`."),
        overwrite: z.boolean().optional().describe("Replace `targetPath` when it exists."),
      }),
      outputSchema,
    },
    async ({ id, path, targetPath, overwrite }, requestInfo) => {
      const result = await refusing(requestInfo.agentId, () =>
        exportSheetXlsx({ agentId: requestInfo.agentId, id, path, targetPath, overwrite }),
      );
      if ("error" in result) return result.error;
      const r = result.value;
      return toolOk(
        `Exported to ${r.path}${r.link ? ` (${r.link})` : ""}. ${dropMessage(r.dropped)}`,
        { data: { yourAgentId: requestInfo.agentId, ...r } },
      );
    },
  );
};
