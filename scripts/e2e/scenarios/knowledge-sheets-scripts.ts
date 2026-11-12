import { asRecord, asString, expect } from "../http";
import type { Scenario } from "../run";
import {
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  structured,
  withMcp,
} from "./script-helpers";
import { configureAgentFs, removeConfigs, startAgentFsStub } from "./sheets-helpers";

/**
 * Flow `sheets`: `ctx.sheets.*` in the native and the quickjs executor. The same call returns the
 * tool's payload without `success`, a refusal throws, and one script walks the whole round trip.
 */
export const knowledgeSheetsScripts: Scenario = {
  name: "knowledge-sheets-scripts",
  order: 593,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "script");
    const agentId = await registerAgent(ctx, "sheets-script");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    try {
      const shared = await withMcp(ctx, agentId, async (mcp) => {
        const created = structured(
          await callToolOk(mcp, "sheet-create", { path: `shared-${ctx.nonce}.sheet.json` }),
        );
        const id = asString(asRecord(created.object).id, "sheet id");
        await callToolOk(mcp, "sheet-set-range", {
          id,
          range: "A1:B2",
          values: [
            [2, "=A1*A1"],
            [3, "=A2*A2"],
          ],
        });
        const read = structured(
          await callToolOk(mcp, "sheet-get-range", { id, range: "A1:B2", formulas: true }),
        );
        const { success: _success, ...tool } = read;
        return { id, tool };
      });

      for (const executor of ["native", "quickjs"] as const) {
        const run = await runScript(
          ctx,
          agentId,
          {
            executor,
            intent: `e2e sheets ${executor} ${ctx.nonce}`,
            source: `export default async (_args, ctx) => {
  const read = await ctx.sheets.getRange({ id: ${JSON.stringify(shared.id)}, range: "A1:B2", formulas: true });
  const created = await ctx.sheets.create({ path: "${executor}-${ctx.nonce}.sheet.json", title: "from script" });
  const id = created.object.id;
  const written = await ctx.sheets.setRange({ id, range: "Tasks!B2:C3", values: [[1, "=B2*2"], [2, "=B3*2"]] }).catch((e) => String(e));
  await ctx.sheets.addTab({ id, name: "Tasks" });
  const set = await ctx.sheets.setRange({ id, range: "Tasks!B2:C3", values: [[1, "=B2*2"], [2, "=B3*2"]] });
  const back = await ctx.sheets.getRange({ id, range: "Tasks!B2:C3" });
  const appended = await ctx.sheets.appendRows({ id, tab: "Tasks", rows: [["x", "=C3+1"]] });
  const cleared = await ctx.sheets.clearRange({ id, range: "Tasks!B2:C2" });
  const info = await ctx.sheets.get({ id });
  const listed = await ctx.sheets.list({ prefix: "${executor}-" });
  return {
    read, refusal: written, success: "success" in read, set: { changed: set.changed, version: set.version },
    values: back.values, appended: appended.range, cleared: cleared.cleared,
    tabs: info.tabs.map((t) => t.name), listed: listed.total, link: created.link,
  };
};`,
          },
          `ctx.sheets ${executor}`,
        );
        expectRunOk(run, `ctx.sheets ${executor}`);
        const result = asRecord(run.result);
        expect(
          JSON.stringify(result.read) === JSON.stringify(shared.tool) && result.success === false,
          `${executor}: ctx.sheets.getRange must return the tool payload without success: ${JSON.stringify(result.read)} vs ${JSON.stringify(shared.tool)}`,
        );
        expect(
          String(result.refusal).includes("no tab 'Tasks'"),
          `${executor}: a refusal throws: ${String(result.refusal)}`,
        );
        expect(
          JSON.stringify(result.values) === "[[1,2],[2,4]]" &&
            asRecord(result.set).changed === 4 &&
            result.appended === "Tasks!A4:B4" &&
            result.cleared === 2 &&
            JSON.stringify(result.tabs) === `["Sheet1","Tasks"]` &&
            result.listed === 1 &&
            typeof result.link === "string",
          `${executor}: round trip: ${JSON.stringify(result)}`,
        );
      }
      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
