import * as XLSX from "xlsx";
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

/** Two tabs, a formula with no cached value, a number format and a merge. */
const workbook = () => {
  const plan = XLSX.utils.aoa_to_sheet([
    ["Item", "Cost"],
    ["A", 4],
    ["B", 6],
  ]);
  plan.C2 = { t: "n", f: "B2*2" };
  plan.B2 = { t: "n", v: 4, z: "0.00" };
  plan["!ref"] = "A1:C3";
  plan["!merges"] = [XLSX.utils.decode_range("A5:B5")];
  const notes = XLSX.utils.aoa_to_sheet([["total"], [{ t: "n", f: "SUM(Plan!B2:B3)" }]]);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, plan, "Plan");
  XLSX.utils.book_append_sheet(wb, notes, "Notes");
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx" }));
};

/**
 * Flow `sheets`: `ctx.sheets.importXlsx` and `exportXlsx` in the native and the quickjs executor
 * return the same payload as the tools (same keys, same `dropped`, same values), and a refusal
 * throws.
 */
export const knowledgeSheetsXlsxScripts: Scenario = {
  name: "knowledge-sheets-xlsx-scripts",
  order: 598,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "xlsx-script");
    const agentId = await registerAgent(ctx, "sheets-xlsx-script");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    const seed = (path: string, bytes: Uint8Array) =>
      fake.files.set(path, { body: "", bytes, version: 1 });
    try {
      seed(`in/plan-${ctx.nonce}.xlsx`, workbook());
      seed(`in/notes-${ctx.nonce}.xlsx`, new TextEncoder().encode("not a zip"));
      const viaTool = await withMcp(ctx, agentId, async (mcp) => {
        const imported = structured(
          await callToolOk(mcp, "sheet-import-xlsx", {
            sourcePath: `in/plan-${ctx.nonce}.xlsx`,
            path: `tool-${ctx.nonce}.sheet.json`,
            title: "From tool",
          }),
        );
        const id = asString(asRecord(imported.object).id, "sheet id");
        const exported = structured(
          await callToolOk(mcp, "sheet-export-xlsx", { id, targetPath: `tool-${ctx.nonce}.xlsx` }),
        );
        const read = structured(
          await callToolOk(mcp, "sheet-get-range", { id, range: "Plan!A1:C3", formulas: true }),
        );
        return { imported, exported, values: read.values, formulas: read.formulas };
      });

      for (const executor of ["native", "quickjs"] as const) {
        const run = await runScript(
          ctx,
          agentId,
          {
            executor,
            intent: `e2e sheets xlsx ${executor} ${ctx.nonce}`,
            source: `export default async (_args, ctx) => {
  const imported = await ctx.sheets.importXlsx({ sourcePath: "in/plan-${ctx.nonce}.xlsx", path: "${executor}-${ctx.nonce}.sheet.json", title: "From script" });
  const id = imported.object.id;
  const exported = await ctx.sheets.exportXlsx({ id, targetPath: "${executor}-${ctx.nonce}.xlsx" });
  const byPath = await ctx.sheets.exportXlsx({ path: "${executor}-${ctx.nonce}.sheet.json", targetPath: "${executor}-by-path-${ctx.nonce}.xlsx" });
  const read = await ctx.sheets.getRange({ id, range: "Plan!A1:C3", formulas: true });
  const refusal = await ctx.sheets.importXlsx({ sourcePath: "in/notes-${ctx.nonce}.xlsx", path: "bad-${executor}-${ctx.nonce}.sheet.json" }).catch((e) => String(e));
  const exists = await ctx.sheets.exportXlsx({ id, targetPath: "${executor}-${ctx.nonce}.xlsx" }).catch((e) => String(e));
  return { imported, exported, byPath, values: read.values, formulas: read.formulas, refusal, exists };
};`,
          },
          `ctx.sheets xlsx ${executor}`,
        );
        expectRunOk(run, `ctx.sheets xlsx ${executor}`);
        const result = asRecord(run.result);
        const keys = (value: unknown) =>
          Object.keys(asRecord(value))
            .filter((key) => key !== "success")
            .sort();
        const imported = asRecord(result.imported);
        const exported = asRecord(result.exported);
        expect(
          JSON.stringify(keys(imported)) === JSON.stringify(keys(viaTool.imported)) &&
            JSON.stringify(keys(exported)) === JSON.stringify(keys(viaTool.exported)) &&
            !("success" in imported) &&
            JSON.stringify(imported.dropped) === JSON.stringify(viaTool.imported.dropped) &&
            JSON.stringify(exported.dropped) === JSON.stringify(viaTool.exported.dropped) &&
            asRecord(imported.object).kind === "sheet" &&
            asRecord(imported.object).title === "From script" &&
            typeof imported.link === "string" &&
            exported.path === `${executor}-${ctx.nonce}.xlsx` &&
            typeof exported.link === "string",
          `${executor}: payload shape: ${JSON.stringify(imported)} / ${JSON.stringify(exported)} vs tool ${JSON.stringify(viaTool.imported)} / ${JSON.stringify(viaTool.exported)}`,
        );
        expect(
          JSON.stringify(result.values) === JSON.stringify(viaTool.values) &&
            JSON.stringify(result.formulas) === JSON.stringify(viaTool.formulas) &&
            JSON.stringify(result.values) === `[["Item","Cost",null],["A",4,8],["B",6,null]]`,
          `${executor}: imported values: ${JSON.stringify(result.values)} vs ${JSON.stringify(viaTool.values)}`,
        );
        expect(
          asRecord(result.byPath).path === `${executor}-by-path-${ctx.nonce}.xlsx`,
          `${executor}: export by path`,
        );
        expect(
          String(result.refusal).includes("not an xlsx workbook") &&
            String(result.exists).includes("pass overwrite: true"),
          `${executor}: refusals throw: ${String(result.refusal)} / ${String(result.exists)}`,
        );
        expect(
          fake.files.has(`${executor}-${ctx.nonce}.xlsx`) &&
            !fake.files.has(`bad-${executor}-${ctx.nonce}.sheet.json`),
          `${executor}: the export landed, the refused import wrote nothing`,
        );
      }
      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
