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

type Grid = Array<Array<number | string | boolean | null>>;

// Strings the engine would coerce to numbers or booleans without the text prefix, plus the escape cases.
const TEXTS = ["$12", " 007", "12%", "1e3", "  TRUE", "(123)", "007", "'abc", "plain"];
const COLUMN: Grid = TEXTS.map((text) => [text]);

/**
 * Flow `sheets`: what a cell holds. Text stays text through every write path and a rebuild, errors
 * and booleans round trip, an identical write is a no-op, a range and its values must have the same
 * shape, quoted tab names resolve, a 10k-cell workbook recalculates, and object-reindex restores a
 * sheet whose row is gone.
 */
export const knowledgeSheetsValues: Scenario = {
  name: "knowledge-sheets-values",
  order: 596,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "values");
    const agentId = await registerAgent(ctx, "sheets-values");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    try {
      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const refused = async (name: string, args: Record<string, unknown>) =>
          toolText(await callToolErr(mcp, name, args));
        const read = async (id: string, range: string) =>
          JSON.stringify((await call("sheet-get-range", { id, range })).values);
        const create = async (path: string, extra: Record<string, unknown> = {}) =>
          asString(asRecord((await call("sheet-create", { path, ...extra })).object).id, "sheet id");

        // An identical write changes nothing and does not bump the version.
        const path = `values-${ctx.nonce}.sheet.json`;
        const id = await create(path);
        await call("sheet-set-range", { id, range: "A1", values: [[5]] });
        const writesBefore = fake.writes();
        const again = await call("sheet-set-range", { id, range: "A1", values: [[5]] });
        expect(
          again.changed === 0 && again.recalculated === 0 && again.version === 2,
          `identical write: ${JSON.stringify(again)}`,
        );
        expect(fake.writes() === writesBefore, "an identical write never reaches agent-fs");

        // Text stays text, '= escapes a literal, null clears, errors read back as their text.
        await call("sheet-set-range", {
          id,
          range: "B1:B6",
          values: [["007"], ["'=not a formula"], ["=1/0"], [true], ["plain"], ["x"]],
        });
        await call("sheet-set-range", { id, range: "B6", values: [[null]] });
        expect(
          (await read(id, "B1:B6")) === `[["007"],["=not a formula"],["#DIV/0!"],[true],["plain"],[null]]`,
          `typed values: ${await read(id, "B1:B6")}`,
        );
        const cells = asRecord(asRecord((storedSheet(fake, path).tabs as unknown[])[0]).cells);
        expect(
          JSON.stringify(cells.B3) === `{"f":"=1/0","v":"#DIV/0!","e":true}`,
          `error cell in the file: ${JSON.stringify(cells.B3)}`,
        );

        // A single cell still expands to the values' shape; an exact match still writes.
        const grow = await create(`grow-${ctx.nonce}.sheet.json`);
        await call("sheet-set-range", { id: grow, range: "A1", values: [[1, 2, 3, 4]] });
        await call("sheet-set-range", { id: grow, range: "A2", values: [[5], [6]] });
        await call("sheet-set-range", {
          id: grow,
          range: "C2:D3",
          values: [
            [7, 8],
            [9, 10],
          ],
        });
        expect(
          (await read(grow, "A1:D3")) === "[[1,2,3,4],[5,null,7,8],[6,null,9,10]]",
          "single-cell expansion and exact match",
        );

        // Equal-area mismatches refuse and leave the file and version alone.
        const guard = await create(`guard-${ctx.nonce}.sheet.json`);
        const guardPath = `guard-${ctx.nonce}.sheet.json`;
        await call("sheet-set-range", { id: guard, range: "C1:D1", values: [["keep C", "keep D"]] });
        await call("sheet-set-range", { id: guard, range: "A3:A4", values: [["keep A3"], ["keep A4"]] });
        const body = fake.files.get(guardPath)?.body;
        const guardWrites = fake.writes();
        const shapes: Array<[string, Grid]> = [
          ["A1:B2", [[1, 2, 3, 4]]],
          ["A1:B2", [[1], [2], [3], [4]]],
          ["A1:D1", [[1], [2], [3], [4]]],
          ["A1:A4", [[1, 2, 3, 4]]],
        ];
        for (const [range, values] of shapes) {
          expect(
            /values is \d+x\d+ but the range is \d+x\d+/.test(
              await refused("sheet-set-range", { id: guard, range, values }),
            ),
            `${range} with ${JSON.stringify(values)} is refused`,
          );
        }
        expect(
          fake.files.get(guardPath)?.body === body && fake.writes() === guardWrites,
          "a refused shape writes nothing",
        );
        expect(
          (await read(guard, "C1:D1")) === `[["keep C","keep D"]]`,
          "the neighbours survive",
        );
        expect(
          (await refused("sheet-set-range", { id, range: "A1048576", values: [[1], [2]] })).includes(
            "runs past",
          ),
          "a write past the last row",
        );

        // Text that looks typed stays text through set, append and create, and a later rebuild.
        const texts = await create(`texts-${ctx.nonce}.sheet.json`);
        await call("sheet-set-range", { id: texts, range: "A1", values: COLUMN });
        await call("sheet-append-rows", { id: texts, tab: "Sheet1", rows: COLUMN });
        const seeded = await create(`seeded-${ctx.nonce}.sheet.json`, {
          tabs: [{ name: "Data", rows: COLUMN }],
        });
        const n = TEXTS.length;
        const both = JSON.stringify([...COLUMN, ...COLUMN]);
        const once = JSON.stringify(COLUMN);
        expect((await read(texts, `A1:A${2 * n}`)) === both, "set and append keep text");
        expect((await read(seeded, `Data!A1:A${n}`)) === once, "create keeps text");
        // Every later write rebuilds the model from the file: the text must survive that too.
        await call("sheet-set-range", { id: texts, range: "C1", values: [[1]] });
        await call("sheet-set-range", { id: seeded, range: "C1", values: [["=1+1"]] });
        expect((await read(texts, `A1:A${2 * n}`)) === both, "text survives a rebuild");
        expect((await read(seeded, `Data!A1:A${n}`)) === once, "seeded text survives a rebuild");

        // Hand-authored text values rebuild as text; formulas and the '= escape keep their meaning.
        const hand = await create(`hand-${ctx.nonce}.sheet.json`);
        const handPath = `hand-${ctx.nonce}.sheet.json`;
        const handDoc = storedSheet(fake, handPath) as { tabs: Array<{ cells: unknown }> };
        const handTab = handDoc.tabs[0];
        expect(handTab, "first tab");
        handTab.cells = {
          A1: { v: "$12" },
          A2: { v: " 007" },
          A3: { v: "=not a formula" },
          A4: { v: 5 },
          A5: { v: "'quoted" },
          B1: { f: "=A4*2", v: 10 },
          B2: { f: '=A1&"!"', v: "$12!" },
        };
        const handStored = fake.files.get(handPath);
        expect(handStored, "stored hand sheet");
        fake.files.set(handPath, {
          body: JSON.stringify(handDoc),
          version: handStored.version + 1,
        });
        await call("sheet-set-range", { id: hand, range: "C1", values: [["'=literal"]] });
        expect(
          (await read(hand, "A1:A5")) ===
            `[["$12"],[" 007"],["=not a formula"],[5],["'quoted"]]`,
          "hand-authored text",
        );
        expect((await read(hand, "B1:B2")) === `[[10],["$12!"]]`, "hand-authored formulas");
        expect((await read(hand, "C1")) === `[["=literal"]]`, "the '= escape");

        // A quoted tab name resolves case-insensitively and reads back in its own case.
        await call("sheet-add-tab", { id, name: "My tab" });
        await call("sheet-set-range", { id, range: "'My tab'!A1", values: [[21]] });
        await call("sheet-set-range", { id, range: "Sheet1!D1", values: [["='My tab'!A1*2"]] });
        expect((await read(id, "D1")) === "[[42]]", "a formula reads a quoted tab");
        expect(
          (await call("sheet-get-range", { id, range: "'my tab'!A1" })).range === "'My tab'!A1",
          "the range reads back in the tab's own case",
        );
        expect(
          (await refused("sheet-add-tab", { id, name: "x", after: "Nope" })).includes("no tab"),
          "add-tab after an unknown tab",
        );

        // A 10k-cell workbook recalculates inside the engine timeout.
        const heavy = await create(`wide-${ctx.nonce}.sheet.json`);
        const rows: Grid = Array.from({ length: 5000 }, (_, i) => [i + 1, `=A${i + 1}*2`]);
        const started = performance.now();
        await call("sheet-set-range", { id: heavy, range: "A1:B5000", values: rows });
        await call("sheet-set-range", { id: heavy, range: "C1", values: [["=SUM(B1:B5000)"]] });
        expect(performance.now() - started < 10_000, "10k cells recalculate in under 10s");
        expect(
          (await read(heavy, "C1")) === "[[25005000]]" && (await read(heavy, "B5000")) === "[[10000]]",
          "the 10k-cell workbook computed",
        );
      });

      // object-reindex restores a sheet whose row is gone, and sheet-list shows only sheets.
      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const lostId = crypto.randomUUID();
        const lostPath = `lost-${ctx.nonce}.sheet.json`;
        fake.files.set(lostPath, {
          body: JSON.stringify({
            format: "swarm-sheet/1",
            swarm: { id: lostId, kind: "sheet" },
            tabs: [{ name: "Sheet1", cells: { A1: { v: 7 } } }],
          }),
          version: 1,
        });
        await call("object-create", { kind: "board", path: `b-${ctx.nonce}.excalidraw` });
        const report = await call("object-reindex", { kind: "sheet" });
        expect(
          JSON.stringify(report.restored) === JSON.stringify([lostPath]),
          `reindex restores the lost row: ${JSON.stringify(report)}`,
        );
        expect(
          JSON.stringify((await call("sheet-get-range", { id: lostId, range: "A1" })).values) ===
            "[[7]]",
          "the restored sheet reads under its embedded id",
        );
        const listed = await call("sheet-list", {});
        const kinds = (listed.objects as Array<Record<string, unknown>>).map((o) => o.kind);
        expect(
          kinds.length === listed.total && kinds.every((kind) => kind === "sheet"),
          `sheet-list returns only sheets: ${JSON.stringify(kinds)}`,
        );
      });

      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
