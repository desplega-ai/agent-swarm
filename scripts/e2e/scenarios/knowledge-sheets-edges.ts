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

/**
 * Flow `sheets`: the edges around the round trip. Seeded tabs on create, a failed seed, row
 * ranges, quoted tab names, bad A1 forms, empty reads and clears, ragged values, null cells,
 * and a hand-broken cell key.
 */
export const knowledgeSheetsEdges: Scenario = {
  name: "knowledge-sheets-edges",
  order: 594,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "edges");
    const agentId = await registerAgent(ctx, "sheets-edges");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    try {
      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const refused = async (name: string, args: Record<string, unknown>) =>
          toolText(await callToolErr(mcp, name, args));
        const values = async (id: string, range: string) =>
          JSON.stringify((await call("sheet-get-range", { id, range })).values);

        // create with seeded tabs: formulas compute, null skips a cell
        const seededPath = `edges-seed-${ctx.nonce}.sheet.json`;
        const seeded = await call("sheet-create", {
          path: seededPath,
          tabs: [
            {
              name: "Data",
              rows: [
                [1, "=A1*2"],
                [null, "x"],
              ],
            },
            { name: "My Tab" },
          ],
        });
        const id = asString(asRecord(seeded.object).id, "seeded sheet id");
        expect((await values(id, "Data!A1:B2")) === `[[1,2],[null,"x"]]`, "seeded rows computed");
        expect(
          JSON.stringify((await call("sheet-get", { id })).tabs) ===
            JSON.stringify([
              { name: "Data", rows: 2, cols: 2, freezeRows: 0 },
              { name: "My Tab", rows: 0, cols: 0, freezeRows: 0 },
            ]),
          "seeded tab list",
        );
        expect(
          JSON.stringify((storedSheet(fake, seededPath).tabs as unknown[]).length) === "2",
          "both tabs are in the file",
        );

        // create refusals on the tab list
        expect(
          (
            await refused("sheet-create", {
              path: `edges-dup-${ctx.nonce}.sheet.json`,
              tabs: [{ name: "A" }, { name: "a" }],
            })
          ).includes("duplicate tab"),
          "seeded tab names are unique, case-insensitively",
        );
        expect(
          (
            await refused("sheet-create", {
              path: `edges-bad-${ctx.nonce}.sheet.json`,
              tabs: [{ name: "a:b" }],
            })
          ).includes("invalid tab name"),
          "seeded tab names are checked",
        );
        // A seed the engine refuses leaves the file created and says so.
        const failedPath = `edges-failed-${ctx.nonce}.sheet.json`;
        const failedSeed = await refused("sheet-create", {
          path: failedPath,
          tabs: [{ name: "S", rows: [["=SEQUENCE(1000000)"]] }],
        });
        expect(
          failedSeed.includes("but could not write its tabs") && failedSeed.includes(failedPath),
          `failed seed: ${failedSeed}`,
        );

        // quoted tab names
        expect((await values(id, "'My Tab'!A1")) === "[[null]]", "a quoted tab name reads");
        await call("sheet-set-range", { id, range: "'My Tab'!A1", values: [["hello"]] });
        expect((await values(id, "'My Tab'!A1")) === `[["hello"]]`, "a quoted tab name writes");
        expect(
          (await refused("sheet-get-range", { id, range: "'My Tab!A1" })).includes(
            "a quoted tab name must be followed by '!'",
          ),
          "an unclosed quote",
        );
        expect(
          (await refused("sheet-get-range", { id, range: "A1:B2:C3" })).includes("bad range"),
          "three corners",
        );
        expect(
          (await refused("sheet-get-range", { id, range: "A1:A1048577" })).includes("bad range"),
          "a row past the grid",
        );

        // row ranges read and clear only the used columns
        expect((await values(id, "Data!1:2")) === `[[1,2],[null,"x"]]`, "a row range reads");
        // an open range beyond the used area reads empty, not an error
        const beyond = await call("sheet-get-range", { id, range: "Data!Z:Z" });
        expect(
          JSON.stringify(beyond.values) === "[]",
          `read beyond the used area: ${JSON.stringify(beyond)}`,
        );
        // clear: nothing in range, nothing inside the used area
        const outside = await call("sheet-clear-range", { id, range: "Data!Z:Z" });
        expect(outside.cleared === 0, `clear outside: ${JSON.stringify(outside)}`);
        const hole = await call("sheet-clear-range", { id, range: "Data!A2" });
        expect(hole.cleared === 0, `clear an empty cell: ${JSON.stringify(hole)}`);
        const rows = await call("sheet-clear-range", { id, range: "Data!1:2" });
        expect(rows.cleared === 3, `clear a row range: ${JSON.stringify(rows)}`);
        expect((await values(id, "Data!A1:B2")) === "[[null,null],[null,null]]", "rows cleared");

        // set-range value shapes
        expect(
          (await refused("sheet-set-range", { id, range: "A1", values: [] })).length > 0,
          "empty values",
        );
        expect(
          (await refused("sheet-set-range", { id, range: "Data!A1", values: [[1, 2], [3]] }))
            .length > 0,
          "ragged values",
        );
        // appendRows skips null cells
        const appended = await call("sheet-append-rows", {
          id,
          tab: "Data",
          rows: [[null, "kept"]],
        });
        expect(appended.range === "Data!B1:B1" || appended.range === "Data!A1:B1", "append range");
        expect((await values(id, "Data!A1:B1")) === `[[null,"kept"]]`, "null cells skipped");

        // a hand-broken cell key is refused with a reason
        const stored = fake.files.get(seededPath);
        expect(stored, "stored sheet");
        const broken = JSON.parse(stored.body) as {
          tabs: Array<{ cells: Record<string, unknown> }>;
        };
        const firstTab = broken.tabs[0];
        expect(firstTab, "first tab");
        firstTab.cells["not-a-cell"] = { v: 1 };
        fake.files.set(seededPath, {
          body: JSON.stringify(broken),
          version: stored.version + 1,
        });
        expect(
          (await refused("sheet-get", { id })).includes("not a valid swarm-sheet/1"),
          "a bad cell key",
        );
      });
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
