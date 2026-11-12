import { asRecord, asString, expect } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";
import { configureAgentFs, removeConfigs, startAgentFsStub, storedSheet } from "./sheets-helpers";

/**
 * Flow `primitive-objects`: a sheet whose `swarm.id` a save dropped is refused with a message that
 * names object-reindex, and object-reindex `prefix` / `dryRun` scope the write-back. A dry run
 * writes nothing; a prefixed run adopts only files under the prefix and reports only rows under it
 * as missing; an unprefixed dry run is the control that would reach the other files.
 */
export const knowledgeObjectsReindexScope: Scenario = {
  name: "knowledge-objects-reindex-scope",
  order: 599,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "rscope");
    const agentId = await registerAgent(ctx, "objects-reindex-scope");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    const mine = `mine-${ctx.nonce}/a.sheet.json`;
    const theirs = `theirs-${ctx.nonce}/b.sheet.json`;
    const gone = `gone-${ctx.nonce}/c.sheet.json`;
    const idless = (value: number) =>
      JSON.stringify({
        format: "swarm-sheet/1",
        tabs: [{ name: "Sheet1", cells: { A1: { v: value } } }],
      });
    try {
      const id = await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const created = await call("sheet-create", { path: mine });
        const sheetId = asString(asRecord(created.object).id, "sheet id");
        await call("sheet-set-range", { id: sheetId, range: "A1", values: [[1]] });
        await call("sheet-create", { path: gone });
        fake.files.delete(gone);

        // A save outside the sheet tools drops swarm.id; another person's file has none either.
        const version = fake.files.get(mine)?.version ?? 0;
        fake.files.set(mine, { body: idless(1), version: version + 1 });
        fake.files.set(theirs, { body: idless(9), version: 1 });

        const refusal = toolText(
          await callToolErr(mcp, "sheet-get-range", { id: sheetId, range: "A1" }),
        );
        expect(
          refusal.includes("no embedded swarm.id") &&
            refusal.includes("object-reindex") &&
            !refusal.includes("expected object"),
          `a dropped id is refused with the fix, not a schema error: ${refusal}`,
        );
        return sheetId;
      });

      // ctx.sheets throws the same refusal; ctx.objects.reindex takes prefix and dryRun.
      for (const executor of ["native", "quickjs"] as const) {
        const writes = fake.writes();
        const run = await runScript(
          ctx,
          agentId,
          {
            executor,
            intent: `e2e reindex scope ${executor} ${ctx.nonce}`,
            source: `export default async (_args, ctx) => {
  const refusal = await ctx.sheets.getRange({ id: ${JSON.stringify(id)}, range: "A1" }).catch((e) => String(e));
  const plan = await ctx.objects.reindex({ kind: "sheet", prefix: ${JSON.stringify(`mine-${ctx.nonce}/`)}, dryRun: true });
  return { refusal, adopted: plan.adopted, dryRun: plan.dryRun };
};`,
          },
          `reindex scope ${executor}`,
        );
        expectRunOk(run, `reindex scope ${executor}`);
        const result = asRecord(run.result);
        expect(
          String(result.refusal).includes("no embedded swarm.id") &&
            String(result.refusal).includes("ctx.objects.reindex"),
          `${executor}: ctx.sheets refusal names the fix: ${String(result.refusal)}`,
        );
        expect(
          result.dryRun === true && JSON.stringify(result.adopted) === JSON.stringify([mine]),
          `${executor}: ctx.objects.reindex dry run: ${JSON.stringify(result)}`,
        );
        expect(fake.writes() === writes, `${executor}: a dry run writes nothing to agent-fs`);
      }

      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const theirsBefore = fake.files.get(theirs)?.body;

        // Control: without a prefix the same dry run would adopt the other file and report the gone row.
        const writes = fake.writes();
        const wide = await call("object-reindex", { kind: "sheet", dryRun: true });
        expect(
          wide.dryRun === true &&
            JSON.stringify([...(wide.adopted as string[])].sort()) ===
              JSON.stringify([mine, theirs].sort()) &&
            JSON.stringify(wide.missing) === JSON.stringify([gone]),
          `unprefixed dry run reaches every id-less file: ${JSON.stringify(wide)}`,
        );
        expect(fake.writes() === writes, "an unprefixed dry run writes nothing");
        expect(
          storedSheet(fake, mine).swarm === undefined,
          "the dry runs left the id-less file as it was",
        );

        // A prefixed run adopts only under the prefix, keeping the row's id.
        const scoped = await call("object-reindex", {
          kind: "sheet",
          prefix: `mine-${ctx.nonce}/`,
        });
        expect(
          scoped.dryRun === false &&
            JSON.stringify(scoped.adopted) === JSON.stringify([mine]) &&
            JSON.stringify(scoped.missing) === "[]",
          `prefixed reindex: ${JSON.stringify(scoped)}`,
        );
        expect(asRecord(storedSheet(fake, mine).swarm).id === id, "the row's id is written back");
        expect(
          fake.files.get(theirs)?.body === theirsBefore,
          "a file outside the prefix is untouched",
        );
        expect(
          JSON.stringify((await call("sheet-get-range", { id, range: "A1" })).values) === "[[1]]",
          "the sheet reads again after reindex",
        );
      });

      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
