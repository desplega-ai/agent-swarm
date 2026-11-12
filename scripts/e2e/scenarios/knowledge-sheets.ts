import { asRecord, asRecords, asString, expect } from "../http";
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
 * Flow `sheets`: the eight sheet-* tools over MCP against a local agent-fs stub, as the agent's
 * own key. A round trip (create, setRange with a formula, getRange returns the recomputed value,
 * appendRows, clearRange, addTab, list, get) and the refusals a caller can hit.
 */
export const knowledgeSheets: Scenario = {
  name: "knowledge-sheets",
  order: 591,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "sheets");
    const agentId = await registerAgent(ctx, "sheets");
    const keyless = await registerAgent(ctx, "sheets-keyless");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    const path = `qa/e2e-${ctx.nonce}.sheet.json`;
    try {
      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const refused = async (name: string, args: Record<string, unknown>) =>
          toolText(await callToolErr(mcp, name, args));

        // create
        const created = await call("sheet-create", { path: `/${path}`, title: "E2E tracker" });
        const object = asRecord(created.object);
        const id = asString(object.id, "sheet id");
        expect(
          object.kind === "sheet" && object.path === path,
          `created object: ${JSON.stringify(object)}`,
        );
        expect(
          typeof created.link === "string" && created.link.endsWith(path),
          "create returns the live link",
        );
        expect(
          JSON.stringify(storedSheet(fake, path)) ===
            JSON.stringify({
              format: "swarm-sheet/1",
              swarm: { id, kind: "sheet", title: "E2E tracker" },
              tabs: [{ name: "Sheet1", cells: {} }],
            }),
          `stored file: ${fake.files.get(path)?.body}`,
        );
        expect(
          (await refused("sheet-create", { path })).includes("already exists"),
          "create is create-only",
        );
        expect(
          (await refused("sheet-create", { path: "x.json" })).includes(".sheet.json"),
          "create needs the suffix",
        );

        // get, by id and by path
        const got = await call("sheet-get", { id });
        expect(
          got.version === 1 &&
            JSON.stringify(got.tabs) ===
              JSON.stringify([{ name: "Sheet1", rows: 0, cols: 0, freezeRows: 0 }]),
          `sheet-get: ${JSON.stringify(got)}`,
        );
        expect(
          asRecord((await call("sheet-get", { path })).object).id === id,
          "get by path resolves the same sheet",
        );

        // setRange with a formula, then getRange returns the recomputed value
        const written = await call("sheet-set-range", {
          id,
          range: "Sheet1!B2:C3",
          values: [
            [1, "=B2*2"],
            [2, "=B3*2"],
          ],
        });
        expect(
          written.range === "Sheet1!B2:C3" &&
            written.changed === 4 &&
            written.recalculated === 0 &&
            written.version === 2,
          `set-range: ${JSON.stringify(written)}`,
        );
        const read = await call("sheet-get-range", { id, range: "B2:C3", formulas: true });
        expect(
          JSON.stringify(read.values) === "[[1,2],[2,4]]" &&
            JSON.stringify(read.formulas) === `[[1,"=B2*2"],[2,"=B3*2"]]` &&
            read.version === 2,
          `get-range: ${JSON.stringify(read)}`,
        );
        // A write to B2 recomputes C2, which is outside the written range.
        const dependents = await call("sheet-set-range", { id, range: "B2", values: [[10]] });
        expect(
          dependents.changed === 1 && dependents.recalculated === 1 && dependents.version === 3,
          `dependents: ${JSON.stringify(dependents)}`,
        );
        expect(
          JSON.stringify((await call("sheet-get-range", { id, range: "C2" })).values) === "[[20]]",
          "the formula recomputed",
        );
        expect(
          JSON.stringify(asRecord((storedSheet(fake, path).tabs as unknown[])[0]).cells).includes(
            `"C2":{"f":"=B2*2","v":20}`,
          ),
          "the cached result is in the file",
        );

        // appendRows lands below the used rows
        const appended = await call("sheet-append-rows", {
          id,
          tab: "Sheet1",
          rows: [["total", "=B2+B3"]],
        });
        expect(appended.range === "Sheet1!A4:B4", `append-rows: ${JSON.stringify(appended)}`);
        expect(
          JSON.stringify((await call("sheet-get-range", { id, range: "A4:B4" })).values) ===
            `[["total",12]]`,
          "the appended formula computed",
        );

        // a spilled formula is visible to getRange, and clearRange takes it away
        await call("sheet-set-range", { id, range: "E1", values: [["=SEQUENCE(3)"]] });
        expect(
          JSON.stringify((await call("sheet-get-range", { id, range: "E1:E3" })).values) ===
            "[[1],[2],[3]]",
          "spilled cells are readable",
        );
        const cleared = await call("sheet-clear-range", { id, range: "E:E" });
        expect(
          cleared.cleared === 1 && cleared.range === "Sheet1!E1:E4",
          `clear-range: ${JSON.stringify(cleared)}`,
        );
        expect(
          JSON.stringify((await call("sheet-get-range", { id, range: "E1:E3" })).values) ===
            "[[null],[null],[null]]",
          "the cleared column reads empty",
        );

        // addTab, a cross-tab formula
        const tabs = await call("sheet-add-tab", { id, name: "Summary" });
        expect(
          JSON.stringify(tabs.tabs) === `["Sheet1","Summary"]`,
          `add-tab: ${JSON.stringify(tabs)}`,
        );
        const middle = await call("sheet-add-tab", { id, name: "Notes", after: "Sheet1" });
        expect(JSON.stringify(middle.tabs) === `["Sheet1","Notes","Summary"]`, "add-tab after");
        await call("sheet-set-range", { id, range: "Summary!A1", values: [["=Sheet1!B2"]] });
        expect(
          JSON.stringify((await call("sheet-get-range", { id, range: "Summary!A1" })).values) ===
            "[[10]]",
          "a formula reads across tabs",
        );

        // list
        const listed = await call("sheet-list", {});
        expect(
          listed.total === 1 && asRecords(listed, "objects")[0]?.id === id,
          `sheet-list: ${JSON.stringify(listed).slice(0, 300)}`,
        );
        expect(
          (await call("sheet-list", { prefix: "/nowhere/" })).total === 0,
          "list filters by prefix",
        );

        // refusals
        expect(
          (await refused("sheet-get", { id: "no-such-id" })).includes("no object"),
          "unknown id",
        );
        expect((await refused("sheet-get", {})).includes("pass `id` or `path`"), "no id or path");
        expect(
          (await refused("sheet-get-range", { id, range: "A1:C" })).includes("bad range"),
          "bad A1 range",
        );
        expect(
          (await refused("sheet-get-range", { id, range: "Nope!A1" })).includes("no tab 'Nope'"),
          "unknown tab",
        );
        expect(
          (await refused("sheet-set-range", { id, range: "A:A", values: [[1]] })).includes(
            "bounded",
          ),
          "open range on write",
        );
        expect(
          (await refused("sheet-set-range", { id, range: "A1:B2", values: [[1, 2, 3]] })).includes(
            "1x3",
          ),
          "values must match the range",
        );
        expect(
          (await refused("sheet-add-tab", { id, name: "Sheet1" })).includes("already exists"),
          "duplicate tab",
        );
        expect(
          (await refused("sheet-add-tab", { id, name: "a:b" })).includes("invalid tab name"),
          "bad tab name",
        );
        expect(
          (await refused("sheet-append-rows", { id, tab: "Nope", rows: [[1]] })).includes("no tab"),
          "append to an unknown tab",
        );

        // a board is not a sheet
        const board = asRecord(
          asRecord(
            structured(
              await callToolOk(mcp, "object-create", {
                kind: "board",
                path: `b-${ctx.nonce}.excalidraw`,
              }),
            ),
          ).object,
        );
        expect(
          (await refused("sheet-get", { id: asString(board.id, "board id") })).includes(
            "is a board, not a sheet",
          ),
          "a board id is refused",
        );

        // a hand-broken file is refused with a reason, not a crash
        const stored = fake.files.get(path);
        expect(stored, "stored sheet");
        fake.files.set(path, {
          body: JSON.stringify({ format: "swarm-sheet/9" }),
          version: stored.version + 1,
        });
        expect(
          (await refused("sheet-get", { id })).includes("not a valid swarm-sheet/1"),
          "invalid file",
        );
        fake.files.delete(path);
        expect(
          (await refused("sheet-get", { id })).includes("missing on the drive"),
          "missing file",
        );
      });

      await withMcp(ctx, keyless, async (mcp) => {
        for (const [name, args] of [
          ["sheet-create", { path: "k.sheet.json" }],
          ["sheet-list", {}],
        ] as const) {
          expect(
            toolText(await callToolErr(mcp, name, args)).includes("no own AGENT_FS_API_KEY"),
            `${name}: an agent without a key is refused`,
          );
        }
      });

      expect(fake.authorizedOnlyAsOwner(), "every agent-fs call carries the agent's own key");
    } finally {
      fake.stop();
      await removeConfigs(ctx, configIds);
    }
  },
};
