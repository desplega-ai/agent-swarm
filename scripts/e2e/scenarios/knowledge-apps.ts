import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  cancelTask,
  createPinnedTask,
  dbCount,
  expectToolError,
  expectToolOk,
  registerAgent,
} from "./knowledge-helpers";

type Json = Record<string, unknown>;

/** The slice of an app definition the scenario edits in place. */
type MutableDefinition = {
  models: Record<string, { columns: Record<string, unknown> }>;
  queries: Record<string, unknown>;
};

const SCRIPT_SOURCE = `export default async function main(args: { n?: number; app?: { id: string }; caller?: { kind: string; id: string | null } }) {
  return { echoed: args.n ?? null, appId: args.app?.id ?? null, callerKind: args.caller?.kind ?? null, callerId: args.caller?.id ?? null };
}
`;

function mainPage(titleText: string) {
  return {
    root: "root",
    elements: {
      root: { type: "Container", props: {}, children: ["heading", "table"] },
      heading: { type: "Heading", props: { text: titleText } },
      table: {
        type: "Table",
        props: {
          data: { $state: "/queries/allItems/data" },
          loading: { $state: "/queries/allItems/loading" },
          error: { $state: "/queries/allItems/error" },
          emptyMessage: "No items yet.",
          columns: [
            { key: "title", label: "Title", kind: "string" },
            { key: "status", label: "Status", kind: "string" },
          ],
        },
      },
    },
  };
}

function itemModel() {
  return {
    columns: {
      title: { kind: "string", required: true },
      status: { kind: "enum", enum: ["open", "done"], default: "open" },
      qty: { kind: "number", default: 0 },
      done: { kind: "boolean", default: false },
      notes: { kind: "string" },
    },
  };
}

function appDefinition(input: {
  agentId: string;
  scriptId: string;
  syncKey: string;
}): Record<string, unknown> {
  return {
    models: {
      item: itemModel(),
      taskrow: {
        columns: {
          taskKey: { kind: "string" },
          taskStatus: { kind: "string", source: { of: "tasks", field: "status" } },
          taskPrompt: { kind: "string", source: { of: "tasks", field: "prompt" } },
          note: { kind: "string" },
        },
        sources: {
          tasks: {
            connector: "swarm-tasks",
            joinKey: "taskKey",
            config: { assetKey: input.syncKey, limit: 50 },
          },
        },
      },
    },
    queries: {
      allItems: { model: "item", sort: { column: "createdAt", dir: "desc" } },
      byStatus: { model: "item", filter: { status: { $param: "status" } } },
    },
    actions: {
      review: { kind: "task", prompt: "Review the items and report back.", agentId: input.agentId },
      echo: { kind: "script", scriptId: input.scriptId, args: { n: 1 } },
      refresh: { kind: "sync", model: "taskrow", source: "tasks" },
    },
    userConfig: {
      density: { kind: "enum", enum: ["compact", "cozy"], default: "cozy", label: "Density" },
    },
    pages: { main: mainPage("Items") },
    defaultPage: "main",
  };
}

async function findScriptId(ctx: ScenarioContext, name: string, agentId: string): Promise<string> {
  const listed = await ctx.api("GET", "/api/scripts?scope=agent&includeScratch=true");
  expectStatus(listed, [200], "list scripts");
  const found = asRecords(listed.json, "scripts").find(
    (script) => script.name === name && script.scopeId === agentId,
  );
  expect(found, `script ${name} is not in GET /api/scripts`);
  return asString(found.id, "script id");
}

export const knowledgeApps: Scenario = {
  name: "knowledge-apps",
  order: 550,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-owner");
    const other = await registerAgent(ctx, "app-other");
    const session = await ctx.connectMcp(owner);
    const sessionOther = await ctx.connectMcp(other);
    const cleanupApps: string[] = [];
    const cleanupTasks: string[] = [];
    try {
      // The script behind the `echo` action: agent scope, owned by `owner`.
      const scriptName = `e2e-app-echo-${ctx.nonce}`;
      let response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: owner,
        body: {
          name: scriptName,
          scope: "agent",
          description: "App action fixture",
          intent: "Echo the app action input",
          source: SCRIPT_SOURCE,
        },
      });
      expectStatus(response, [200], "upsert the action script");
      const scriptId = await findScriptId(ctx, scriptName, owner);

      const syncKey = `shared/e2e-${ctx.nonce}-sync/`;
      const definition = appDefinition({ agentId: owner, scriptId, syncKey });

      // ── Create ──────────────────────────────────────────────────────────────────────────────
      response = await ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: { name: `E2E app ${ctx.nonce}`, description: "knowledge e2e", definition },
      });
      expectStatus(response, [201], "create an app");
      const app = asRecord(asRecord(response.json).app);
      const appId = asString(app.id, "app id");
      cleanupApps.push(appId);
      expect(
        app.name === `E2E app ${ctx.nonce}` &&
          app.description === "knowledge e2e" &&
          typeof app.createdAt === "string" &&
          typeof app.updatedAt === "string",
        `created app: ${JSON.stringify(app).slice(0, 300)}`,
      );
      const storedDefinition = asRecord(app.definition);
      expect(
        Object.keys(asRecord(storedDefinition.models)).sort().join() === "item,taskrow" &&
          storedDefinition.defaultPage === "main" &&
          storedDefinition.schemaVersion !== undefined,
        "the stored definition keeps the models and gains a server-managed schemaVersion",
      );
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM apps WHERE id = ?", [appId]) === 1,
        "app row was not persisted",
      );

      response = await ctx.api("POST", "/api/apps", {
        body: {
          name: "bad",
          definition: { models: { item: { columns: {} } }, pages: {}, defaultPage: "nope" },
        },
      });
      expectStatus(response, [400], "create an app with an invalid definition");
      const invalid = asRecord(response.json);
      expect(
        invalid.error === "invalid app definition" &&
          asRecords(invalid, "issues").length > 0 &&
          typeof asRecords(invalid, "issues")[0]?.path === "string",
        `invalid definitions answer path-bearing issues: ${response.text.slice(0, 200)}`,
      );
      response = await ctx.api("POST", "/api/apps", {
        body: { name: "bad", definition, forceElementBreak: ["x"] },
      });
      expectStatus(response, [400], "forceElementBreak on create");
      response = await ctx.api("POST", "/api/apps", { body: { definition } });
      expectStatus(response, [400], "create an app without a name");

      // ── Read: list and get ──────────────────────────────────────────────────────────────────
      response = await ctx.api("GET", `/api/apps?q=${encodeURIComponent(`E2E app ${ctx.nonce}`)}`);
      expectStatus(response, [200], "list apps");
      const summaries = asRecords(response.json, "apps");
      expect(
        summaries.length === 1 &&
          summaries[0]?.id === appId &&
          summaries[0]?.definition === undefined,
        "app summaries omit the definition",
      );
      response = await ctx.api("GET", "/api/apps?limit=1");
      expect(asRecords(response.json, "apps").length === 1, "list apps honours limit");
      response = await ctx.api("GET", "/api/apps?limit=0");
      expectStatus(response, [400], "list apps with an invalid limit");
      response = await ctx.api("GET", `/api/apps/${appId}`, { agentId: owner });
      expectStatus(response, [200], "get an app");
      let doc = asRecord(response.json);
      expect(asRecord(doc.app).id === appId, "get app");
      expect(doc.syncStatus === undefined, "no sync status before the first sync");
      response = await ctx.api("GET", `/api/apps/${crypto.randomUUID()}`);
      expectStatus(response, [404], "get an unknown app");

      // ── Rows: create, validate, list, filter, sort, get, patch, delete ──────────────────────
      response = await ctx.api("POST", `/api/apps/${appId}/models/item/rows`, {
        agentId: owner,
        body: { values: { title: "first", qty: 5 } },
      });
      expectStatus(response, [201], "create a row");
      const first = asRecord(asRecord(response.json).row);
      const firstId = asString(first.id, "row id");
      expect(
        first.title === "first" &&
          first.qty === 5 &&
          first.status === "open" &&
          first.done === false &&
          first.createdBy === `agent:${owner}` &&
          typeof first.createdAt === "string",
        `row defaults and provenance: ${JSON.stringify(first)}`,
      );
      for (const [label, values] of [
        ["missing required column", { qty: 1 }],
        ["unknown column", { title: "x", bogus: 1 }],
        ["invalid enum value", { title: "x", status: "weird" }],
        ["wrong kind", { title: "x", qty: "many" }],
      ] as const) {
        response = await ctx.api("POST", `/api/apps/${appId}/models/item/rows`, {
          body: { values },
        });
        expectStatus(response, [400], `create row: ${label}`);
        expect(asRecords(response.json, "issues").length > 0, `row issues for ${label}`);
      }
      response = await ctx.api("POST", `/api/apps/${appId}/models/taskrow/rows`, {
        body: { values: { taskStatus: "forged" } },
      });
      expectStatus(response, [400], "source-bound columns reject direct writes");
      response = await ctx.api("POST", `/api/apps/${appId}/models/ghost/rows`, {
        body: { values: { title: "x" } },
      });
      expectStatus(response, [404], "create a row in an unknown model");
      response = await ctx.api("POST", `/api/apps/${crypto.randomUUID()}/models/item/rows`, {
        body: { values: { title: "x" } },
      });
      expectStatus(response, [404], "create a row in an unknown app");

      response = await ctx.api("POST", `/api/apps/${appId}/models/item/rows/bulk`, {
        body: {
          rows: [
            { values: { title: "second", qty: 20, status: "done" } },
            { values: { title: "third", qty: 10 } },
            { values: { title: "fourth", qty: 1, notes: "n" } },
          ],
        },
      });
      expectStatus(response, [200], "bulk create rows");
      const bulk = asRecords(response.json, "rows");
      expect(bulk.length === 3 && bulk.every((row) => typeof row.id === "string"), "bulk rows");
      response = await ctx.api("POST", `/api/apps/${appId}/models/item/rows/bulk`, {
        body: { rows: [{ values: { title: "ok" } }, { values: { qty: 1 } }] },
      });
      expectStatus(response, [400], "bulk create with one invalid row");
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?limit=100`);
      expect(
        asRecord(response.json).total === 4,
        "a bulk create with an invalid row must be all or nothing",
      );

      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows`);
      expectStatus(response, [200], "list rows");
      expect(asRecord(response.json).total === 4, "list rows total");
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?filter.status=done`);
      let rowsDoc = asRecord(response.json);
      expect(
        rowsDoc.total === 1 && asRecords(rowsDoc, "rows")[0]?.title === "second",
        "equality filter",
      );
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?sort=qty:desc&limit=2`);
      rowsDoc = asRecord(response.json);
      expect(
        asRecords(rowsDoc, "rows")
          .map((row) => row.title)
          .join() === "second,third" && rowsDoc.total === 4,
        `sort and limit: ${JSON.stringify(asRecords(rowsDoc, "rows").map((row) => row.title))}`,
      );
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?filter.qty=abc`);
      expectStatus(response, [400], "list rows with an invalid filter value");
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?filter.ghost=1`);
      expectStatus(response, [400], "list rows with an unknown filter column");
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?sort=ghost:asc`);
      expectStatus(response, [400], "list rows with an invalid sort");
      response = await ctx.api("GET", `/api/apps/${appId}/models/ghost/rows`);
      expectStatus(response, [404], "list rows of an unknown model");

      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows/${firstId}`);
      expectStatus(response, [200], "get a row");
      expect(asRecord(asRecord(response.json).row).title === "first", "get row");
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows/missing-row`);
      expectStatus(response, [404], "get an unknown row");
      response = await ctx.api("PATCH", `/api/apps/${appId}/models/item/rows/${firstId}`, {
        agentId: other,
        body: { values: { status: "done", qty: 6 } },
      });
      expectStatus(response, [200], "patch a row");
      const patched = asRecord(asRecord(response.json).row);
      expect(
        patched.status === "done" &&
          patched.qty === 6 &&
          patched.title === "first" &&
          patched.createdBy === `agent:${owner}` &&
          patched.updatedBy === `agent:${other}`,
        `patched row keeps unchanged columns and records the updater: ${JSON.stringify(patched)}`,
      );
      response = await ctx.api("PATCH", `/api/apps/${appId}/models/item/rows/${firstId}`, {
        body: { values: { status: "weird" } },
      });
      expectStatus(response, [400], "patch a row with an invalid value");
      response = await ctx.api("PATCH", `/api/apps/${appId}/models/item/rows/missing-row`, {
        body: { values: { qty: 1 } },
      });
      expectStatus(response, [404], "patch an unknown row");

      // ── Named queries ───────────────────────────────────────────────────────────────────────
      response = await ctx.api("GET", `/api/apps/${appId}/queries/allItems`);
      expectStatus(response, [200], "run a named query");
      expect(asRecords(response.json, "rows").length === 4, "allItems returns every row");
      response = await ctx.api("GET", `/api/apps/${appId}/queries/byStatus?param.status=done`);
      expectStatus(response, [200], "run a parameterised query");
      expect(
        asRecords(response.json, "rows").length === 2 &&
          asRecords(response.json, "rows").every((row) => row.status === "done"),
        "byStatus filters on the $param",
      );
      response = await ctx.api("GET", `/api/apps/${appId}/queries/byStatus`);
      expectStatus(response, [400], "run a query without its $param");
      expect(
        JSON.stringify(asRecord(response.json).missingParams) === JSON.stringify(["status"]),
        "missingParams names the absent parameter",
      );
      response = await ctx.api("GET", `/api/apps/${appId}/queries/byStatus?param.status=weird`);
      expectStatus(response, [400], "run a query with an invalid $param value");
      response = await ctx.api(
        "GET",
        `/api/apps/${appId}/queries/byStatus?param.status=open&param.extra=1`,
      );
      expectStatus(response, [400], "run a query with an undeclared $param");
      response = await ctx.api("GET", `/api/apps/${appId}/queries/ghost`);
      expectStatus(response, [404], "run an unknown query");

      // ── Per-user configuration ──────────────────────────────────────────────────────────────
      response = await ctx.api("GET", `/api/apps/${appId}/user-config`);
      expectStatus(response, [200], "get user config");
      let userConfig = asRecord(response.json);
      expect(
        asRecord(userConfig.values).density === "cozy" &&
          asRecord(asRecord(userConfig.schema).density).kind === "enum",
        `user config defaults: ${response.text}`,
      );
      response = await ctx.api("PUT", `/api/apps/${appId}/user-config`, {
        body: { values: { density: "compact", $theme: "ember" } },
      });
      expectStatus(response, [200], "set user config");
      userConfig = asRecord(response.json);
      expect(asRecord(userConfig.values).density === "compact", "user config is stored");
      response = await ctx.api("GET", `/api/apps/${appId}/user-config`);
      expect(
        asRecord(asRecord(response.json).values).density === "compact",
        "user config persists",
      );
      response = await ctx.api("PUT", `/api/apps/${appId}/user-config`, {
        body: { values: { density: "huge" } },
      });
      expectStatus(response, [400], "set an invalid user config value");
      response = await ctx.api("PUT", `/api/apps/${appId}/user-config`, {
        body: { values: { density: "cozy" }, extra: true },
      });
      expectStatus(response, [400], "user config body is strict");
      response = await ctx.api("PUT", `/api/apps/${appId}/user-config`, {
        agentId: owner,
        body: { values: { density: "cozy" } },
      });
      expectStatus(response, [403], "an agent has no user scope for user config");
      response = await ctx.api("GET", `/api/apps/${crypto.randomUUID()}/user-config`);
      expectStatus(response, [404], "user config of an unknown app");
      response = await ctx.api("PUT", `/api/apps/${crypto.randomUUID()}/user-config`, {
        body: { values: { density: "cozy" } },
      });
      expectStatus(response, [404], "set user config of an unknown app");

      // ── Actions: task, script, sync ─────────────────────────────────────────────────────────
      response = await ctx.api("POST", `/api/apps/${appId}/actions/review`, {
        agentId: owner,
        body: { input: { focus: "qty" } },
      });
      expectStatus(response, [200], "run a task action");
      const taskAction = asRecord(response.json);
      const actionTaskId = asString(taskAction.taskId, "action task id");
      cleanupTasks.push(actionTaskId);
      expect(taskAction.ok === true && typeof taskAction.status === "string", "task action body");
      response = await ctx.api("GET", `/api/tasks/${actionTaskId}`);
      expectStatus(response, [200], "read the action task");
      const actionTask = asRecord(response.json);
      expect(
        actionTask.agentId === owner &&
          actionTask.key === `shared/app:${appId}/action:review/` &&
          String(actionTask.task).includes("Review the items") &&
          String(actionTask.task).includes('"focus":"qty"'),
        `action task: ${JSON.stringify(actionTask).slice(0, 300)}`,
      );
      const parentTask = await createPinnedTask(ctx, owner, "app action parent");
      cleanupTasks.push(parentTask);
      response = await ctx.api("POST", `/api/apps/${appId}/actions/review`, {
        body: { parentTaskId: parentTask },
      });
      expectStatus(response, [200], "run a task action under a parent task");
      const childTaskId = asString(asRecord(response.json).taskId, "chained task id");
      cleanupTasks.push(childTaskId);
      expect(
        ctx.db.get<{ parentTaskId: string | null }>(
          "SELECT parentTaskId FROM agent_tasks WHERE id = ?",
          [childTaskId],
        )?.parentTaskId === parentTask,
        "parentTaskId chains the action task",
      );
      response = await ctx.api("POST", `/api/apps/${appId}/actions/review`, {
        body: { parentTaskId: crypto.randomUUID() },
      });
      expectStatus(response, [404], "action under an unknown parent task");
      response = await ctx.api("POST", `/api/apps/${appId}/actions/echo`, {
        body: { parentTaskId: parentTask },
      });
      expectStatus(response, [400], "parentTaskId on a script action");
      response = await ctx.api("POST", `/api/apps/${appId}/actions/ghost`, { body: {} });
      expectStatus(response, [404], "run an unknown action");
      response = await ctx.api("POST", `/api/apps/${crypto.randomUUID()}/actions/review`, {
        body: {},
      });
      expectStatus(response, [404], "run an action of an unknown app");

      response = await ctx.api("POST", `/api/apps/${appId}/actions/echo`, {
        agentId: owner,
        body: { input: { n: 7 } },
      });
      expectStatus(response, [200], "run a script action");
      const scriptAction = asRecord(response.json);
      expect(
        scriptAction.ok === true &&
          typeof scriptAction.durationMs === "number" &&
          typeof scriptAction.stdout === "string",
        `script action body: ${response.text.slice(0, 300)}`,
      );
      const scriptResult = asRecord(scriptAction.result);
      expect(
        scriptResult.echoed === 7 &&
          scriptResult.appId === appId &&
          scriptResult.callerKind === "agent" &&
          scriptResult.callerId === owner,
        `the script receives the input, the app id and the verified caller: ${JSON.stringify(scriptResult)}`,
      );
      response = await ctx.api("POST", `/api/apps/${appId}/actions/echo`, { body: {} });
      expect(
        asRecord(asRecord(response.json).result).callerKind === "operator" &&
          asRecord(asRecord(response.json).result).echoed === 1,
        "an operator caller has no id and the action args are the defaults",
      );

      // ── Sync (swarm-tasks connector) ────────────────────────────────────────────────────────
      const syncedTasks: string[] = [];
      for (const label of ["alpha", "beta"]) {
        const created = await ctx.api("POST", "/api/tasks", {
          body: {
            task: `sync fixture ${label} ${ctx.nonce}`,
            agentId: owner,
            routingReason: "human_pinned",
            source: "api",
            key: syncKey,
          },
        });
        expectStatus(created, [201], `create sync task ${label}`);
        syncedTasks.push(asString(asRecord(created.json).id, "sync task id"));
      }
      cleanupTasks.push(...syncedTasks);
      response = await ctx.api("POST", `/api/apps/${appId}/sync`, { body: {} });
      expectStatus(response, [200], "sync an app");
      const syncDoc = asRecord(response.json);
      let passes = asRecords(syncDoc, "passes");
      expect(
        syncDoc.ok === true && passes.length === 1,
        `sync result: ${response.text.slice(0, 300)}`,
      );
      expect(
        passes[0]?.model === "taskrow" &&
          passes[0]?.source === "tasks" &&
          passes[0]?.connector === "swarm-tasks" &&
          passes[0]?.pulled === 2 &&
          passes[0]?.created === 2,
        `first pass pulls and creates both tasks: ${JSON.stringify(passes[0])}`,
      );
      response = await ctx.api("GET", `/api/apps/${appId}/models/taskrow/rows`);
      const syncedRows = asRecords(response.json, "rows");
      expect(
        syncedRows.length === 2 &&
          syncedRows.every(
            (row) =>
              row.source === "tasks" &&
              typeof row.syncedAt === "string" &&
              row.stale === false &&
              syncedTasks.includes(String(row.taskKey)) &&
              String(row.taskPrompt).includes(ctx.nonce),
          ),
        `synced rows carry the provenance envelope: ${JSON.stringify(syncedRows[0])}`,
      );
      response = await ctx.api("POST", `/api/tasks/${syncedTasks[0]}/cancel`, { body: {} });
      expectStatus(response, [200], "cancel a synced task");
      response = await ctx.api("POST", `/api/apps/${appId}/sync`, {
        body: { model: "taskrow", source: "tasks" },
      });
      expectStatus(response, [200], "sync again");
      passes = asRecords(response.json, "passes");
      expect(
        passes[0]?.created === 0 && passes[0]?.updated === 1,
        `a second pass updates only the changed task: ${JSON.stringify(passes[0])}`,
      );
      response = await ctx.api("GET", `/api/apps/${appId}`);
      doc = asRecord(response.json);
      const syncStatus = asRecord(doc.syncStatus);
      expect(
        asRecord(syncStatus["taskrow:tasks"]).ok === true,
        `GET app carries per-source sync status: ${JSON.stringify(doc.syncStatus)}`,
      );
      response = await ctx.api("POST", `/api/apps/${appId}/sync`, { body: { model: "ghost" } });
      expectStatus(response, [400], "sync an unknown model");
      response = await ctx.api("POST", `/api/apps/${crypto.randomUUID()}/sync`, { body: {} });
      expectStatus(response, [404], "sync an unknown app");
      response = await ctx.api("POST", `/api/apps/${appId}/actions/refresh`, { body: {} });
      expectStatus(response, [200], "run a sync action");
      const refresh = asRecord(response.json);
      expect(
        refresh.ok === true &&
          asRecords(asRecord(refresh.result), "passes").length === 1 &&
          typeof refresh.durationMs === "number",
        `sync action reuses the script-action shape: ${response.text.slice(0, 200)}`,
      );

      // ── Update (PUT), patch (PATCH), versions, rollback ─────────────────────────────────────
      const extended = structuredClone(definition) as MutableDefinition;
      extended.models.item!.columns.extra = { kind: "string" };
      extended.queries.openItems = { model: "item", filter: { status: "open" } };
      response = await ctx.api("PUT", `/api/apps/${appId}`, {
        agentId: owner,
        body: { definition: extended, name: `E2E app ${ctx.nonce} v2` },
      });
      expectStatus(response, [200], "update an app definition");
      let written = asRecord(response.json);
      expect(asRecord(written.app).name === `E2E app ${ctx.nonce} v2`, "update renames the app");
      const report = asRecord(written.migration);
      expect(
        typeof report.scanned === "number" &&
          Array.isArray(report.orphanFields) &&
          report.purgedValues === 0,
        `migration report: ${JSON.stringify(report)}`,
      );
      response = await ctx.api("PUT", `/api/apps/${appId}`, { body: { description: "renamed" } });
      expectStatus(response, [200], "update only the description");
      expect(
        asRecord(asRecord(response.json).app).description === "renamed",
        "update without a definition keeps the definition",
      );
      response = await ctx.api("PUT", `/api/apps/${appId}`, {
        body: { definition: { models: {}, pages: {}, defaultPage: "x" } },
      });
      expectStatus(response, [400], "update with an invalid definition");
      response = await ctx.api("PUT", `/api/apps/${crypto.randomUUID()}`, { body: { name: "x" } });
      expectStatus(response, [404], "update an unknown app");

      response = await ctx.api("PATCH", `/api/apps/${appId}`, {
        agentId: owner,
        body: {
          description: null,
          definition: { queries: { doneItems: { model: "item", filter: { status: "done" } } } },
        },
      });
      expectStatus(response, [200], "patch an app");
      written = asRecord(response.json);
      const patchedQueries = asRecord(asRecord(asRecord(written.app).definition).queries);
      expect(
        patchedQueries.doneItems !== undefined &&
          patchedQueries.openItems !== undefined &&
          patchedQueries.allItems !== undefined,
        "a merge patch adds one query and keeps the others",
      );
      expect(asRecord(written.app).description === undefined, "description: null clears it");
      response = await ctx.api("PATCH", `/api/apps/${appId}`, {
        body: { definition: { queries: { doneItems: null } } },
      });
      expectStatus(response, [200], "patch with null deletes");
      expect(
        asRecord(asRecord(asRecord(asRecord(response.json).app).definition).queries).doneItems ===
          undefined,
        "null deletes a query",
      );
      response = await ctx.api("PATCH", `/api/apps/${appId}`, {
        body: { definition: { queries: { broken: { model: "ghost" } } } },
      });
      expectStatus(response, [400], "patch into an invalid definition");
      response = await ctx.api("PATCH", `/api/apps/${crypto.randomUUID()}`, { body: {} });
      expectStatus(response, [404], "patch an unknown app");

      response = await ctx.api("GET", `/api/apps/${appId}/versions`, { agentId: owner });
      expectStatus(response, [200], "list app versions");
      const versions = asRecords(response.json, "versions");
      expect(
        versions.map((version) => version.version).join() === "4,3,2,1",
        `each definition write snapshots the previous definition: ${versions.map((v) => v.version).join()}`,
      );
      response = await ctx.api("GET", `/api/apps/${appId}/versions/1`);
      expectStatus(response, [200], "get app version 1");
      const versionOne = asRecord(asRecord(response.json).version);
      const snapshotDefinition = asRecord(asRecord(versionOne.snapshot).definition);
      expect(
        versionOne.version === 1 &&
          versionOne.appId === appId &&
          asRecord(asRecord(asRecord(snapshotDefinition.models).item).columns).extra === undefined,
        "version 1 is the original definition",
      );
      response = await ctx.api("GET", `/api/apps/${appId}/versions/99`);
      expectStatus(response, [404], "get an unknown version");
      response = await ctx.api("GET", `/api/apps/${appId}/versions/0`);
      expectStatus(response, [400], "get version 0");
      response = await ctx.api("GET", `/api/apps/${crypto.randomUUID()}/versions`);
      expectStatus(response, [404], "versions of an unknown app");
      response = await ctx.api("GET", `/api/apps/${crypto.randomUUID()}/versions/1`);
      expectStatus(response, [404], "a version of an unknown app");

      response = await ctx.api("POST", `/api/apps/${appId}/rollback`, {
        agentId: owner,
        body: { version: 1 },
      });
      expectStatus(response, [200], "roll back to version 1");
      const rolledBack = asRecord(asRecord(response.json).app);
      expect(
        asRecord(asRecord(asRecord(rolledBack.definition).models).item).columns !== undefined &&
          asRecord(asRecord(asRecord(asRecord(rolledBack.definition).models).item).columns)
            .extra === undefined &&
          asRecord(rolledBack.definition).queries !== undefined &&
          asRecord(asRecord(rolledBack.definition).queries).openItems === undefined,
        "rollback restores the old definition",
      );
      expect(
        asRecords((await ctx.api("GET", `/api/apps/${appId}/versions`)).json, "versions").length ===
          5,
        "a rollback snapshots the definition it replaces",
      );
      response = await ctx.api("POST", `/api/apps/${appId}/rollback`, { body: { version: 99 } });
      expectStatus(response, [404], "roll back to an unknown version");
      response = await ctx.api("POST", `/api/apps/${crypto.randomUUID()}/rollback`, {
        body: { version: 1 },
      });
      expectStatus(response, [404], "roll back an unknown app");
      response = await ctx.api("POST", `/api/apps/${appId}/rollback`, { body: { version: 0 } });
      expectStatus(response, [400], "roll back to version 0");

      // A lossy schema change is rejected until a migration directive says how to coerce.
      const lossy = structuredClone(definition) as MutableDefinition;
      lossy.models.item!.columns.qty = { kind: "string" };
      response = await ctx.api("PUT", `/api/apps/${appId}`, { body: { definition: lossy } });
      expectStatus(response, [400], "a lossy kind change without a directive");
      expect(
        asRecords(response.json, "issues").length > 0,
        "lossy changes report per-column issues",
      );
      response = await ctx.api("PUT", `/api/apps/${appId}`, {
        body: { definition: lossy, migration: { qty: { coerce: true, else: "0" } } },
      });
      expectStatus(response, [200], "a lossy kind change with a coerce directive");
      expect(
        (asRecord(asRecord(response.json).migration).coerced as number) >= 1,
        `coerce directive converted the stored values: ${JSON.stringify(asRecord(response.json).migration)}`,
      );
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?sort=qty:asc`);
      expect(
        asRecords(response.json, "rows").every((row) => typeof row.qty === "string"),
        "coerced rows hold strings now",
      );

      // ── Row delete ──────────────────────────────────────────────────────────────────────────
      response = await ctx.api("DELETE", `/api/apps/${appId}/models/item/rows/${firstId}`);
      expectStatus(response, [200], "delete a row");
      expect(asRecord(response.json).ok === true, "delete row body");
      response = await ctx.api("DELETE", `/api/apps/${appId}/models/item/rows/${firstId}`);
      expectStatus(response, [404], "delete a row twice");
      response = await ctx.api("GET", `/api/apps/${appId}/models/item/rows/${firstId}`);
      expectStatus(response, [404], "get a deleted row");

      // ── MCP tools on a second app ───────────────────────────────────────────────────────────
      const toolDefinition = {
        models: {
          note: {
            columns: {
              title: { kind: "string", required: true },
              n: { kind: "number", default: 0 },
            },
          },
        },
        queries: {
          allNotes: { model: "note", sort: { column: "n", dir: "asc" } },
          byTitle: { model: "note", filter: { title: { $param: "title" } } },
        },
        pages: {
          main: { root: "root", elements: { root: { type: "Container", props: {} } } },
        },
        defaultPage: "main",
      };
      let outcome = expectToolOk(
        await callTool(session, "app-upsert", {
          name: `E2E tool app ${ctx.nonce}`,
          description: "created by app-upsert",
          definition: toolDefinition,
        }),
        "app-upsert create",
      );
      const toolAppId = asString(outcome.data.appId, "tool app id");
      cleanupApps.push(toolAppId);
      expect(outcome.data.url === `/apps/${toolAppId}`, "app-upsert url");
      expectToolError(
        await callTool(session, "app-upsert", {
          name: "bad",
          definition: { models: { note: { columns: {} } }, pages: {}, defaultPage: "x" },
        }),
        "app-upsert invalid definition",
        /Invalid app definition/i,
      );
      expectToolError(
        await callTool(session, "app-upsert", {
          name: "bad",
          definition: toolDefinition,
          migration: { n: { set: 1 } },
        }),
        "app-upsert migration without appId",
        /requires appId/i,
      );
      expectToolError(
        await callTool(session, "app-upsert", {
          name: "bad",
          definition: toolDefinition,
          forceElementBreak: ["x"],
        }),
        "app-upsert forceElementBreak without appId",
        /requires appId/i,
      );
      expectToolError(
        await callTool(session, "app-upsert", {
          appId: crypto.randomUUID(),
          name: "ghost",
          definition: toolDefinition,
        }),
        "app-upsert unknown appId",
        /not found/i,
      );
      const withExtra = structuredClone(toolDefinition) as unknown as MutableDefinition;
      withExtra.models.note!.columns.tag = { kind: "string" };
      outcome = expectToolOk(
        await callTool(session, "app-upsert", {
          appId: toolAppId,
          name: `E2E tool app ${ctx.nonce}`,
          definition: withExtra,
        }),
        "app-upsert update",
      );
      expect(
        asRecord(outcome.data.migration).scanned !== undefined,
        "app-upsert update reports a migration",
      );

      outcome = expectToolOk(await callTool(session, "app-list", {}), "app-list");
      expect(
        (outcome.data.apps as Json[]).some((row) => row.id === toolAppId),
        "app-list lists the tool app",
      );
      outcome = expectToolOk(await callTool(session, "app-get", { appId: toolAppId }), "app-get");
      expect(
        asRecord(outcome.data.app).id === toolAppId &&
          asRecord(asRecord(asRecord(asRecord(outcome.data.app).definition).models).note)
            .columns !== undefined,
        "app-get returns the definition",
      );
      expectToolError(
        await callTool(session, "app-get", { appId: crypto.randomUUID() }),
        "app-get unknown",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "app-patch", {
          appId: toolAppId,
          description: "patched by tool",
          definition: {
            queries: { newest: { model: "note", sort: { column: "n", dir: "desc" } } },
          },
        }),
        "app-patch",
      );
      expect(
        asRecord(asRecord(asRecord(outcome.data.app).definition).queries).newest !== undefined,
        "app-patch merges the query",
      );
      expectToolError(
        await callTool(session, "app-patch", {
          appId: toolAppId,
          definition: { queries: { broken: { model: "ghost" } } },
        }),
        "app-patch invalid",
        /Invalid app definition/i,
      );
      expectToolError(
        await callTool(session, "app-patch", { appId: crypto.randomUUID(), name: "x" }),
        "app-patch unknown",
        /not found/i,
      );

      // Rows via tools.
      outcome = expectToolOk(
        await callTool(session, "app-row-create", {
          appId: toolAppId,
          model: "note",
          values: { title: "one", n: 1 },
        }),
        "app-row-create",
      );
      const noteOne = asString(asRecord(outcome.data.row).id, "note id");
      expect(
        asRecord(outcome.data.row).createdBy === `agent:${owner}`,
        "tool rows record the agent",
      );
      outcome = expectToolOk(
        await callTool(session, "app-rows-create", {
          appId: toolAppId,
          model: "note",
          rows: [
            { title: "two", n: 2 },
            { title: "three", n: 3 },
            { title: "three", n: 4 },
          ],
        }),
        "app-rows-create",
      );
      expect((outcome.data.rows as unknown[]).length === 3, "app-rows-create count");
      expectToolError(
        await callTool(session, "app-row-create", {
          appId: toolAppId,
          model: "note",
          values: { n: 1 },
        }),
        "app-row-create invalid",
      );
      expectToolError(
        await callTool(session, "app-row-create", { appId: toolAppId, model: "ghost", values: {} }),
        "app-row-create unknown model",
        /Model not found/i,
      );
      expectToolError(
        await callTool(session, "app-row-create", {
          appId: crypto.randomUUID(),
          model: "note",
          values: { title: "x" },
        }),
        "app-row-create unknown app",
        /App not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "app-rows-list", {
          appId: toolAppId,
          model: "note",
          equals: { title: "three" },
          sort: "n:desc",
          limit: 1,
        }),
        "app-rows-list",
      );
      expect(
        outcome.data.total === 2 &&
          (outcome.data.rows as Json[]).length === 1 &&
          (outcome.data.rows as Json[])[0]?.n === 4,
        `app-rows-list filter, sort and limit: ${JSON.stringify(outcome.data.rows)}`,
      );
      expectToolError(
        await callTool(session, "app-rows-list", {
          appId: toolAppId,
          model: "note",
          equals: { ghost: 1 },
        }),
        "app-rows-list unknown column",
      );
      outcome = expectToolOk(
        await callTool(session, "app-row-get", { appId: toolAppId, model: "note", rowId: noteOne }),
        "app-row-get",
      );
      expect(asRecord(outcome.data.row).title === "one", "app-row-get");
      expectToolError(
        await callTool(session, "app-row-get", { appId: toolAppId, model: "note", rowId: "nope" }),
        "app-row-get unknown row",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(sessionOther, "app-row-patch", {
          appId: toolAppId,
          model: "note",
          rowId: noteOne,
          values: { n: 10 },
        }),
        "app-row-patch",
      );
      expect(
        asRecord(outcome.data.row).n === 10 &&
          asRecord(outcome.data.row).updatedBy === `agent:${other}`,
        "app-row-patch records the updater",
      );
      expectToolError(
        await callTool(session, "app-row-patch", {
          appId: toolAppId,
          model: "note",
          rowId: "nope",
          values: { n: 1 },
        }),
        "app-row-patch unknown row",
        /not found/i,
      );

      // Named query via tool.
      outcome = expectToolOk(
        await callTool(session, "app-query", { appId: toolAppId, query: "allNotes" }),
        "app-query",
      );
      expect(
        outcome.data.count === 4 &&
          (outcome.data.rows as Json[]).map((row) => row.n).join() === "2,3,4,10",
        `app-query sorts by the declared column: ${JSON.stringify(outcome.data.rows)}`,
      );
      outcome = expectToolOk(
        await callTool(session, "app-query", {
          appId: toolAppId,
          query: "byTitle",
          params: { title: "three" },
        }),
        "app-query with params",
      );
      expect(outcome.data.count === 2, "app-query filters on the $param");
      const missing = expectToolError(
        await callTool(session, "app-query", { appId: toolAppId, query: "byTitle" }),
        "app-query without its param",
        /missing query parameter/i,
      );
      expect(
        JSON.stringify(missing.data.missingParams) === JSON.stringify(["title"]),
        "app-query names the missing parameter",
      );
      expectToolError(
        await callTool(session, "app-query", { appId: toolAppId, query: "ghost" }),
        "app-query unknown query",
        /not found/i,
      );

      // Deletes.
      expectToolOk(
        await callTool(session, "app-row-delete", {
          appId: toolAppId,
          model: "note",
          rowId: noteOne,
        }),
        "app-row-delete",
      );
      expectToolError(
        await callTool(session, "app-row-delete", {
          appId: toolAppId,
          model: "note",
          rowId: noteOne,
        }),
        "app-row-delete twice",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "app-rows-delete", {
          appId: toolAppId,
          model: "note",
          equals: { title: "three" },
        }),
        "app-rows-delete",
      );
      expect(outcome.data.deleted === 2, "app-rows-delete counts the removed rows");
      response = await ctx.api("GET", `/api/apps/${toolAppId}/models/note/rows`);
      expect(asRecord(response.json).total === 1, "one note remains");
      const emptyFilter = await session.callTool("app-rows-delete", {
        appId: toolAppId,
        model: "note",
        equals: {},
      });
      expect(
        asRecord(emptyFilter).isError === true,
        "app-rows-delete refuses an empty equality filter",
      );

      // History, diff, rollback via tools.
      outcome = expectToolOk(
        await callTool(session, "app-history", { appId: toolAppId, limit: 10 }),
        "app-history",
      );
      const toolVersions = outcome.data.versions as Json[];
      expect(
        toolVersions.length === 2 && outcome.data.currentHead === 2,
        `two definition writes since create: ${JSON.stringify(toolVersions.map((v) => v.version))}`,
      );
      expectToolError(
        await callTool(session, "app-history", { appId: crypto.randomUUID() }),
        "app-history unknown",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "app-diff", { appId: toolAppId, from: 1 }),
        "app-diff default to CURRENT",
      );
      expect(
        outcome.data.fromLabel === "v1" &&
          outcome.data.toLabel === "CURRENT" &&
          String(outcome.data.diff).includes("tag"),
        "app-diff shows the added column",
      );
      outcome = expectToolOk(
        await callTool(session, "app-diff", { appId: toolAppId, from: 1, to: 2 }),
        "app-diff between versions",
      );
      expect(outcome.data.toLabel === "v2", "app-diff to a version");
      expectToolError(
        await callTool(session, "app-diff", { appId: toolAppId, from: 99 }),
        "app-diff unknown version",
        /not found/i,
      );
      expectToolError(
        await callTool(session, "app-diff", { appId: crypto.randomUUID() }),
        "app-diff unknown app",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "app-rollback", { appId: toolAppId, version: 1 }),
        "app-rollback",
      );
      expect(
        asRecord(
          asRecord(asRecord(asRecord(asRecord(outcome.data.app).definition).models).note).columns,
        ).tag === undefined,
        "app-rollback restores version 1",
      );
      expectToolError(
        await callTool(session, "app-rollback", { appId: toolAppId, version: 99 }),
        "app-rollback unknown version",
        /not found/i,
      );

      // Sync and actions via tools, on the first app.
      outcome = expectToolOk(await callTool(session, "app-sync", { appId }), "app-sync");
      expect(
        outcome.data.ok === true && (outcome.data.passes as unknown[]).length === 1,
        "app-sync runs the declared pass",
      );
      expectToolError(
        await callTool(session, "app-sync", { appId: toolAppId }),
        "app-sync of an app with no source",
        /Cannot sync/i,
      );
      expectToolError(
        await callTool(session, "app-sync", { appId: crypto.randomUUID() }),
        "app-sync unknown app",
        /not found/i,
      );
      outcome = expectToolOk(
        await callTool(session, "app-action-run", {
          appId,
          action: "review",
          input: { via: "mcp" },
        }),
        "app-action-run task",
      );
      cleanupTasks.push(asString(outcome.data.taskId, "mcp action task id"));
      outcome = expectToolOk(
        await callTool(session, "app-action-run", { appId, action: "echo", input: { n: 3 } }),
        "app-action-run script",
      );
      expect(
        asRecord(outcome.data.result).echoed === 3 &&
          asRecord(outcome.data.result).callerKind === "agent",
        "app-action-run script result",
      );
      expectToolError(
        await callTool(session, "app-action-run", { appId, action: "ghost" }),
        "app-action-run unknown action",
        /not found/i,
      );
      expectToolError(
        await callTool(session, "app-action-run", { appId: crypto.randomUUID(), action: "echo" }),
        "app-action-run unknown app",
        /not found/i,
      );

      // ── Delete ──────────────────────────────────────────────────────────────────────────────
      response = await ctx.api("DELETE", `/api/apps/${appId}`);
      expectStatus(response, [200], "delete an app");
      expect(asRecord(response.json).ok === true, "delete app body");
      cleanupApps.splice(cleanupApps.indexOf(appId), 1);
      expect(
        dbCount(ctx, "SELECT count(*) AS n FROM apps WHERE id = ?", [appId]) === 0 &&
          dbCount(ctx, "SELECT count(*) AS n FROM kv_entries WHERE namespace = ?", [
            `apps:${appId}`,
          ]) === 0,
        "deleting an app purges its rows",
      );
      response = await ctx.api("GET", `/api/apps/${appId}`);
      expectStatus(response, [404], "get a deleted app");
      response = await ctx.api("DELETE", `/api/apps/${appId}`);
      expectStatus(response, [404], "delete an app twice");
    } finally {
      for (const id of cleanupApps) await ctx.api("DELETE", `/api/apps/${id}`);
      for (const id of cleanupTasks) await cancelTask(ctx, id).catch(() => {});
      await sessionOther.close();
      await session.close();
    }
  },
};
