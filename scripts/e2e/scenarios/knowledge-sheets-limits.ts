import { asRecord, asString, expect } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  registerAgent,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";
import { configureAgentFs, removeConfigs, startAgentFsStub, storedSheet } from "./sheets-helpers";

const grid = (rows: number, cols: number) =>
  Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1));

const cellsOf = (sheet: Record<string, unknown>, tab: number) =>
  asRecord(asRecord((sheet.tabs as unknown[])[tab]).cells);

/**
 * Flow `sheets`: each size limit refuses, an agent-fs 409 re-reads and merges, and the
 * 4th conflict refuses and writes nothing.
 */
export const knowledgeSheetsLimits: Scenario = {
  name: "knowledge-sheets-limits",
  order: 592,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "limits");
    const agentId = await registerAgent(ctx, "sheets-limits");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    try {
      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const refused = async (name: string, args: Record<string, unknown>) =>
          toolText(await callToolErr(mcp, name, args));
        const create = async (path: string) =>
          asString(asRecord((await call("sheet-create", { path })).object).id, "sheet id");

        const id = await create(`limits-${ctx.nonce}.sheet.json`);
        const path = `limits-${ctx.nonce}.sheet.json`;

        // 10,000 cells per range call, on every tool that takes a range or rows.
        expect(
          (await refused("sheet-get-range", { id, range: "A1:CW101" })).includes("10000 per call"),
          "get-range size",
        );
        expect(
          (await refused("sheet-set-range", { id, range: "A1", values: grid(101, 100) })).includes(
            "10000 per call",
          ),
          "set-range size",
        );
        expect(
          (
            await refused("sheet-append-rows", { id, tab: "Sheet1", rows: grid(101, 100) })
          ).includes("10000 per call"),
          "append-rows size",
        );
        expect(
          (await refused("sheet-clear-range", { id, range: "A1:CW101" })).includes(
            "10000 per call",
          ),
          "clear-range size",
        );
        expect(
          (
            await refused("sheet-create", {
              path: "seed.sheet.json",
              tabs: [{ name: "T", rows: grid(101, 100) }],
            })
          ).includes("10000"),
          "create seed size",
        );
        expect(!fake.files.has("seed.sheet.json"), "a refused create leaves no file behind");

        // 20 tabs per workbook.
        for (let i = 2; i <= 20; i++) await call("sheet-add-tab", { id, name: `t${i}` });
        expect(
          (await refused("sheet-add-tab", { id, name: "t21" })).includes("at most 20 tabs"),
          "tab limit",
        );

        // 50,000 cells per workbook: five full writes fit, a sixth is refused.
        for (let i = 2; i <= 6; i++)
          await call("sheet-set-range", { id, range: `t${i}!A1`, values: grid(100, 100) });
        expect(
          (await refused("sheet-set-range", { id, range: "t7!A1", values: [[1]] })).includes(
            "exceed 50000 cells",
          ),
          "cell limit",
        );
        expect(
          Object.keys(cellsOf(storedSheet(fake, path), 1)).length === 10_000,
          "a refused write changed nothing",
        );
        // A runaway spill is refused by the same cap before the engine evaluates it.
        expect(
          (
            await refused("sheet-set-range", {
              id,
              range: "t8!A1",
              values: [["=SEQUENCE(1000000)"]],
            })
          ).includes("spilled by array formulas"),
          "spill past the cell limit",
        );

        // 5 MiB per file. One MCP request is capped at 4 MiB, so the file grows over two writes.
        const heavy = await create(`heavy-${ctx.nonce}.sheet.json`);
        const blob = "x".repeat(1_000_000);
        const three = [[blob], [blob], [blob]];
        await call("sheet-set-range", { id: heavy, range: "A1:A3", values: three });
        expect(
          (await refused("sheet-set-range", { id: heavy, range: "B1:B3", values: three })).includes(
            "5 MiB",
          ),
          "file size limit",
        );
        expect(
          Object.keys(cellsOf(storedSheet(fake, `heavy-${ctx.nonce}.sheet.json`), 0)).length === 3,
          "a refused write stores nothing",
        );

        // An agent-fs 409 re-reads and re-applies: a different cell merges.
        const merge = await create(`merge-${ctx.nonce}.sheet.json`);
        const mergePath = `merge-${ctx.nonce}.sheet.json`;
        const intrude = (cell: string, value: string) => {
          let done = false;
          fake.beforeWrite((target) => {
            if (done) return;
            done = true;
            const current = fake.files.get(target);
            const other = JSON.parse(current?.body ?? "{}");
            other.tabs[0].cells[cell] = { v: value };
            fake.files.set(target, {
              body: JSON.stringify(other),
              version: (current?.version ?? 0) + 1,
            });
          });
        };
        intrude("A1", "theirs");
        const before = fake.writes();
        const merged = await call("sheet-set-range", {
          id: merge,
          range: "B1",
          values: [["mine"]],
        });
        expect(
          fake.writes() - before === 2,
          `one conflict, one retry: ${fake.writes() - before} writes`,
        );
        expect(merged.version === 3, `merged version: ${JSON.stringify(merged)}`);
        expect(
          JSON.stringify((await call("sheet-get-range", { id: merge, range: "A1:B1" })).values) ===
            `[["theirs","mine"]]`,
          "both edits survive the merge",
        );

        // The same cell: the retrying writer wins.
        intrude("A1", "theirs-again");
        await call("sheet-set-range", { id: merge, range: "A1", values: [["mine-again"]] });
        expect(
          JSON.stringify((await call("sheet-get-range", { id: merge, range: "A1" })).values) ===
            `[["mine-again"]]`,
          "last writer wins on the same cell",
        );

        // Every attempt conflicts: refuse after the retry cap and leave the other writer's file alone.
        fake.beforeWrite((target) => {
          const current = fake.files.get(target);
          fake.files.set(target, {
            body: current?.body ?? "",
            version: (current?.version ?? 0) + 1,
          });
        });
        const attempts = fake.writes();
        const refusal = await refused("sheet-set-range", {
          id: merge,
          range: "C1",
          values: [["never"]],
        });
        expect(refusal.includes("concurrent writers"), `conflict cap: ${refusal}`);
        expect(
          fake.writes() - attempts === 4,
          `first try plus three retries: ${fake.writes() - attempts} writes`,
        );
        expect(
          cellsOf(storedSheet(fake, mergePath), 0).C1 === undefined,
          "the refused write is not stored",
        );
        fake.beforeWrite(undefined);
        await call("sheet-set-range", { id: merge, range: "C1", values: [["now"]] });
      });
      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
