import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod";
import { AppNameSchema, type ModelDef, SYSTEM_COLUMN_KINDS } from "../apps/definition";
import {
  type AppRow,
  AppRowAppNotFoundError,
  AppRowValidationError,
  createAppRow,
  createAppRows,
  deleteAppRow,
  getAppRow,
  patchAppRow,
  validValue,
} from "../apps/row-store";
import { appDefinitionNeedsRepair, getApp } from "../apps/store";
import { getAgentById } from "../be/db";
import {
  MAX_APP_BULK_ROWS_BODY_BYTES,
  MAX_APP_ROW_BODY_BYTES,
  rowMatchesFilters,
  selectAppRows,
} from "../http/apps";
import { can } from "../rbac";
import {
  createToolRegistrar,
  type SwarmToolResult,
  swarmToolOutputSchema,
  toolErr,
  toolOk,
} from "./utils";

const base = { appId: z.string().min(1), model: AppNameSchema };
const rowId = z.string().min(1);
const values = z.record(z.string(), z.unknown());
const equals = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));
const limit = z.number().int().min(1).max(1000);
const rowOutput = { row: z.looseObject({}).optional() };
const rowsOutput = { rows: z.array(z.looseObject({})).optional() };

function checkSize(value: unknown, max: number): void {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > max) {
    throw new AppRowValidationError([
      { path: "values", message: `Row input exceeds ${max} bytes.` },
    ]);
  }
}

function rowFilters(model: ModelDef, equals: Record<string, string | number | boolean> = {}) {
  return Object.entries(equals).map(([column, value]) => {
    const declared = Object.hasOwn(model.columns, column) ? model.columns[column] : undefined;
    if ((!declared && !Object.hasOwn(SYSTEM_COLUMN_KINDS, column)) || declared?.hidden) {
      throw new AppRowValidationError([
        { path: `equals.${column}`, message: "Unknown or hidden column." },
      ]);
    }
    if (declared?.kind === "json") {
      throw new AppRowValidationError([
        { path: `equals.${column}`, message: "json columns cannot be filtered" },
      ]);
    }
    if (!validValue(declared ?? { kind: SYSTEM_COLUMN_KINDS[column]! }, value)) {
      throw new AppRowValidationError([
        { path: `equals.${column}`, message: "Filter value must match the column kind." },
      ]);
    }
    return { column, value };
  });
}

export function registerAppRowTools(server: McpServer) {
  function register<Shape extends z.ZodRawShape>(
    name: string,
    description: string,
    shape: Shape,
    output: z.ZodRawShape,
    operation: (
      args: z.infer<z.ZodObject<typeof base & Shape>>,
      model: ModelDef,
      actor: string,
    ) => Promise<SwarmToolResult>,
    readOnly = false,
  ) {
    createToolRegistrar(server)(
      name,
      {
        title: description,
        description,
        annotations: { readOnlyHint: readOnly },
        rbac: { permission: "app.use" },
        inputSchema: z.object({ ...base, ...shape }),
        outputSchema: swarmToolOutputSchema(output),
      },
      async (args, info) => {
        if (!info.agentId) return toolErr('Agent ID not found. Set the "X-Agent-ID" header.');
        const { appId, model: modelName } = z.object(base).parse(args);
        const agent = await getAgentById(info.agentId);
        const decision = can({
          principal: { kind: "agent", agentId: info.agentId, isLead: agent?.isLead ?? false },
          verb: "app.use",
          resource: { kind: "app", appId },
          source: "mcp",
        });
        if (!decision.allow) return toolErr(decision.reason);
        const app = await getApp(appId);
        if (!app) return toolErr("App not found.");
        if (appDefinitionNeedsRepair(app))
          return toolErr("App definition needs repair.", { data: { issues: app.definitionError } });
        if (!Object.hasOwn(app.definition.models, modelName)) return toolErr("Model not found.");
        try {
          return await operation(args, app.definition.models[modelName]!, `agent:${info.agentId}`);
        } catch (error) {
          if (error instanceof AppRowValidationError)
            return toolErr(error.message, { data: { issues: error.issues } });
          if (error instanceof AppRowAppNotFoundError) return toolErr(error.message);
          throw error;
        }
      },
    );
  }

  register(
    "app-rows-list",
    "List app rows with equality filters, sorting, and a limit.",
    {
      equals: equals.optional(),
      sort: z.string().optional(),
      limit: limit.optional(),
    },
    { ...rowsOutput, total: z.number().optional() },
    async (args, model) => {
      const data = await selectAppRows(
        args.appId,
        args.model,
        model,
        rowFilters(model, args.equals),
        args.sort,
        args.limit,
        true,
      );
      return toolOk(`Found ${data.total} row(s).`, { data });
    },
    true,
  );

  register(
    "app-row-get",
    "Get an app row.",
    { rowId },
    rowOutput,
    async (args) => {
      const row = await getAppRow(args.appId, args.model, args.rowId);
      return row ? toolOk("Row retrieved.", { data: { row } }) : toolErr("Row not found.");
    },
    true,
  );

  register(
    "app-row-create",
    "Create an app row.",
    { values },
    rowOutput,
    async (args, model, actor) => {
      checkSize({ values: args.values }, MAX_APP_ROW_BODY_BYTES);
      const row = await createAppRow(args.appId, args.model, model, args.values, { actor });
      return toolOk("Row created.", { data: { row } });
    },
  );

  register(
    "app-rows-create",
    "Create up to 500 app rows within 10 MiB.",
    {
      rows: z.array(values).min(1).max(500),
    },
    rowsOutput,
    async (args, model, actor) => {
      checkSize({ rows: args.rows }, MAX_APP_BULK_ROWS_BODY_BYTES);
      for (const values of args.rows) checkSize({ values }, MAX_APP_ROW_BODY_BYTES);
      const rows = await createAppRows(args.appId, args.model, model, args.rows, { actor });
      return toolOk(`Created ${rows.length} row(s).`, { data: { rows } });
    },
  );

  register(
    "app-row-patch",
    "Patch an app row.",
    { rowId, values },
    rowOutput,
    async (args, model, actor) => {
      checkSize({ values: args.values }, MAX_APP_ROW_BODY_BYTES);
      const row = await patchAppRow(args.appId, args.model, model, args.rowId, args.values, {
        actor,
      });
      return row ? toolOk("Row updated.", { data: { row } }) : toolErr("Row not found.");
    },
  );

  register(
    "app-row-delete",
    "Delete an app row.",
    { rowId },
    { ok: z.boolean().optional() },
    async (args, model) => {
      const deleted = await deleteAppRow(args.appId, args.model, model, args.rowId);
      return deleted ? toolOk("Row deleted.", { data: { ok: true } }) : toolErr("Row not found.");
    },
  );

  register(
    "app-rows-delete",
    "Delete matching app rows. Supply at least one equality filter.",
    {
      equals: equals.refine(
        (value) => Object.keys(value).length > 0,
        "Supply at least one equality filter.",
      ),
      limit: limit.optional(),
    },
    { deleted: z.number().optional() },
    async (args, model) => {
      const filters = rowFilters(model, args.equals);
      const { rows } = await selectAppRows(
        args.appId,
        args.model,
        model,
        filters,
        undefined,
        args.limit ?? 1000,
        true,
      );
      // Re-check under the row lock: a row patched out of the filter since the select is kept.
      const matches = (row: AppRow) => rowMatchesFilters(row, filters);
      let deleted = 0;
      for (const row of rows)
        if (await deleteAppRow(args.appId, args.model, model, row.id, matches)) deleted++;
      return toolOk(`Deleted ${deleted} row(s).`, { data: { deleted } });
    },
  );
}
