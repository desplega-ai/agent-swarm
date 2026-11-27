import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { registerAgent, upsertScript } from "./script-helpers";

/** More rows than one list page (1,000), so the export proves it has no list cap. */
const ROWS = 1_500;
const MISSING_CONNECTION = "e2eImportMissingConn";

// Synthetic fixture: the action calls a connection no e2e swarm registers.
const ACTION_SOURCE = `export default async function (_args: Record<string, unknown>, ctx: any) {
  return await ctx.api.${MISSING_CONNECTION}.listThings({});
}`;

/**
 * `GET /api/apps/{id}/export` then `POST /api/apps/import`: every row comes
 * back with its id, the script action points at a live local script with a
 * new id, and the import warns about the connection the script needs.
 */
export const appsExportImport: Scenario = {
  name: "apps-export-import",
  order: 558.8,
  async run(ctx) {
    const owner = await registerAgent(ctx, "app-bundle-owner");
    const scriptName = `e2e-app-bundle-refresh-${ctx.nonce}`;
    const appIds: string[] = [];
    try {
      const script = await upsertScript(ctx, owner, {
        name: scriptName,
        scope: "agent",
        description: "App bundle fixture",
        intent: "Exercise app export and import",
        source: ACTION_SOURCE,
      });
      const created = await ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: {
          name: `E2E bundle ${ctx.nonce}`,
          description: "export and import",
          definition: {
            models: {
              item: {
                columns: { n: { kind: "number" }, label: { kind: "string", index: true } },
              },
            },
            queries: {},
            actions: { refresh: { kind: "script", scriptId: script.id } },
            pages: {
              main: { root: "root", elements: { root: { type: "Container", props: {} } } },
            },
            defaultPage: "main",
          },
        },
      });
      expectStatus(created, [201], "create the source app");
      const sourceAppId = asString(asRecord(asRecord(created.json).app).id, "source app id");
      appIds.push(sourceAppId);
      for (let start = 0; start < ROWS; start += 500) {
        const rows = Array.from({ length: 500 }, (_, i) => ({
          values: { n: start + i, label: `l${(start + i) % 3}` },
        }));
        const bulk = await ctx.api("POST", `/api/apps/${sourceAppId}/models/item/rows/bulk`, {
          body: { rows },
        });
        expectStatus(bulk, [200], "bulk create rows");
      }

      const exported = await ctx.api("GET", `/api/apps/${sourceAppId}/export`, {
        agentId: owner,
      });
      expectStatus(exported, [200], "export the app");
      const bundle = asRecord(exported.json);
      expect(bundle.format === "swarm-app-bundle/v1", "the bundle names its format");
      const exportedRows = asRecords(asRecord(bundle.rows), "item");
      expect(exportedRows.length === ROWS, `export carries all ${ROWS} rows, past the list cap`);
      const scripts = asRecords(bundle, "scripts");
      expect(
        scripts.length === 1 &&
          scripts[0]!.id === script.id &&
          scripts[0]!.source === ACTION_SOURCE,
        "export carries the action's script with its source",
      );
      const sampleRow = exportedRows[742]!;

      // Remove the source app and its script, so the import must recreate the
      // script under a new id and rewrite the action to it.
      expectStatus(await ctx.api("DELETE", `/api/apps/${sourceAppId}`), [200], "delete source");
      appIds.splice(appIds.indexOf(sourceAppId), 1);
      const dropped = await ctx.api(
        "DELETE",
        `/api/scripts/${encodeURIComponent(scriptName)}?scope=agent`,
        { agentId: owner },
      );
      expectStatus(dropped, [200], "delete the source script");

      const imported = await ctx.api("POST", "/api/apps/import", { agentId: owner, body: bundle });
      expectStatus(imported, [201], "import the bundle");
      const result = asRecord(imported.json);
      const app = asRecord(result.app);
      const appId = asString(app.id, "imported app id");
      appIds.push(appId);
      expect(appId !== sourceAppId, "the import mints a new app id");
      expect(asRecord(result.rows).item === ROWS, "the import reports every row written");
      const newScriptId = asString(asRecord(result.scriptIds)[script.id], "mapped script id");
      expect(newScriptId !== script.id, "the deleted script is recreated under a new id");
      const action = asRecord(asRecord(asRecord(app.definition).actions).refresh);
      expect(action.scriptId === newScriptId, "the action points at the recreated script");
      const resolved = await ctx.api("GET", `/api/scripts/${newScriptId}`, { agentId: owner });
      expectStatus(resolved, [200], "the rewritten scriptId resolves");
      const resolvedScript = asRecord(asRecord(resolved.json).script ?? resolved.json);
      expect(
        resolvedScript.name === scriptName && resolvedScript.scopeId === owner,
        "the recreated script keeps its name in the importer's scope",
      );
      const warnings = (result.warnings as unknown[]).map(String);
      expect(
        warnings.some(
          (warning) =>
            warning.includes("actions.refresh") && warning.includes(`"${MISSING_CONNECTION}"`),
        ),
        `a warning names the missing connection: ${JSON.stringify(warnings)}`,
      );

      const listed = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?limit=1`);
      expectStatus(listed, [200], "list imported rows");
      expect(asRecord(listed.json).total === ROWS, "row counts match after import");
      const row = await ctx.api(
        "GET",
        `/api/apps/${appId}/models/item/rows/${asString(sampleRow.id, "row id")}`,
      );
      expectStatus(row, [200], "a row keeps its id");
      expect(asRecord(asRecord(row.json).row).n === sampleRow.n, "a row keeps its values");
      const filtered = await ctx.api("GET", `/api/apps/${appId}/models/item/rows?filter.label=l1`);
      expectStatus(filtered, [200], "filter on the indexed column");
      expect(asRecord(filtered.json).total === ROWS / 3, "imported rows carry their index keys");

      // A second import reuses the script by name and source instead of copying it.
      const again = await ctx.api("POST", "/api/apps/import", { agentId: owner, body: bundle });
      expectStatus(again, [201], "import the bundle again");
      const againResult = asRecord(again.json);
      appIds.push(asString(asRecord(againResult.app).id, "second app id"));
      expect(
        asRecord(againResult.scriptIds)[script.id] === newScriptId,
        "the second import reuses the script",
      );

      const keep = await ctx.api("POST", "/api/apps/import?keepId=1", {
        agentId: owner,
        body: { ...bundle, app: { ...asRecord(bundle.app), id: appId } },
      });
      expectStatus(keep, [409], "keepId on an existing app id");

      const badRows = await ctx.api("POST", "/api/apps/import", {
        agentId: owner,
        body: { ...bundle, rows: { item: [{ ...sampleRow, n: "not a number" }] } },
      });
      expectStatus(badRows, [400], "a row with a wrong value kind");

      // The import refuses work the definition does not need, before any lookup.
      const unreferenced = await ctx.api("POST", "/api/apps/import", {
        agentId: owner,
        body: { ...bundle, scripts: [...scripts, { ...scripts[0]!, id: "not-wired" }] },
      });
      expectStatus(unreferenced, [400], "a script the definition does not reference");
      const tooMany = await ctx.api("POST", "/api/apps/import", {
        agentId: owner,
        body: {
          ...bundle,
          scripts: Array.from({ length: 101 }, (_, i) => ({ ...scripts[0]!, id: `s${i}` })),
        },
      });
      expectStatus(tooMany, [413], "more scripts than the import cap");
    } finally {
      for (const id of appIds) await ctx.api("DELETE", `/api/apps/${id}`);
      await ctx.api("DELETE", `/api/scripts/${encodeURIComponent(scriptName)}?scope=agent`, {
        agentId: owner,
      });
    }
  },
};
