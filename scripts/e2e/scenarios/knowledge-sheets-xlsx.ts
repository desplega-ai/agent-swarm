import * as XLSX from "xlsx";
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
import {
  configureAgentFs,
  removeConfigs,
  startAgentFsStub,
  withMethod,
  zipOf,
} from "./sheets-helpers";

const fixture = async (name: string) =>
  new Uint8Array(
    await Bun.file(
      new URL(`../../../src/tests/fixtures/sheets/${name}`, import.meta.url),
    ).arrayBuffer(),
  );

const grid = (rows: number, cols: number) =>
  XLSX.utils.aoa_to_sheet(
    Array.from({ length: rows }, () => Array.from({ length: cols }, () => 1)),
  );

const workbook = (tabs: Array<[string, XLSX.WorkSheet]>) => {
  const wb = XLSX.utils.book_new();
  for (const [name, ws] of tabs) XLSX.utils.book_append_sheet(wb, ws, name);
  return new Uint8Array(XLSX.write(wb, { type: "array", bookType: "xlsx", compression: true }));
};

/** Declare a different uncompressed size for one zip part, in the central directory and its local header. */
function declareSize(bytes: Uint8Array, name: string, size: number): Uint8Array {
  const out = new Uint8Array(bytes);
  const view = new DataView(out.buffer);
  for (let i = 0; i < out.length - 46; i++) {
    if (view.getUint32(i, true) !== 0x02014b50) continue;
    const nameLen = view.getUint16(i + 28, true);
    if (new TextDecoder().decode(out.subarray(i + 46, i + 46 + nameLen)) === name) {
      view.setUint32(i + 24, size, true);
      view.setUint32(view.getUint32(i + 42, true) + 22, size, true);
    }
  }
  return out;
}

type Grid = Array<Array<string | number | boolean | null>>;

/**
 * Flow `sheets`: sheet-import-xlsx and sheet-export-xlsx over MCP against the agent-fs stub, as
 * the agent's own key. A fixture workbook with two tabs and 120 formulas round-trips (import,
 * read, export, re-import) with the same tabs, values and formula count. Then every refusal: not
 * an xlsx, over the file, tab and cell limits, a zip bomb, an unknown id, a board, an existing
 * target. Nothing is created when an import refuses.
 */
export const knowledgeSheetsXlsx: Scenario = {
  name: "knowledge-sheets-xlsx",
  order: 595,
  async run(ctx) {
    const fake = startAgentFsStub(ctx, "xlsx");
    const agentId = await registerAgent(ctx, "sheets-xlsx");
    const keyless = await registerAgent(ctx, "sheets-xlsx-keyless");
    const configIds = await configureAgentFs(ctx, agentId, fake);
    const seed = (path: string, bytes: Uint8Array) =>
      fake.files.set(path, { body: "", bytes, version: 1 });
    try {
      const tracker = await fixture("tracker-export.xlsx");
      seed(`in/tracker-${ctx.nonce}.xlsx`, tracker);
      await withMcp(ctx, agentId, async (mcp) => {
        const call = async (name: string, args: Record<string, unknown>) =>
          structured(await callToolOk(mcp, name, args));
        const refused = async (name: string, args: Record<string, unknown>) =>
          toolText(await callToolErr(mcp, name, args));
        const sheetCount = async () => Number((await call("sheet-list", {})).total);
        /**
         * Values and formulas of every tab, read through sheet-get-range. Five rows per call:
         * the agent-facing result is bounded, and a bigger grid comes back truncated.
         */
        const readAll = async (id: string) => {
          const tabs = (await call("sheet-get", { id })).tabs as Array<{
            name: string;
            rows: number;
            cols: number;
          }>;
          const out: Record<string, { values: Grid; formulas: Grid }> = {};
          for (const tab of tabs) {
            expect(tab.cols <= 26, `tab ${tab.name} is wider than column Z`);
            const last = String.fromCharCode(64 + tab.cols);
            const grids = { values: [] as Grid, formulas: [] as Grid };
            for (let row = 1; row <= tab.rows; row += 5) {
              const read = await call("sheet-get-range", {
                id,
                range: `${tab.name}!A${row}:${last}${Math.min(row + 4, tab.rows)}`,
                formulas: true,
              });
              grids.values.push(...(read.values as Grid));
              grids.formulas.push(...(read.formulas as Grid));
            }
            expect(
              grids.values.length === tab.rows,
              `tab ${tab.name}: read ${grids.values.length} of ${tab.rows} rows`,
            );
            out[tab.name] = grids;
          }
          return out;
        };
        const formulaCount = (all: Record<string, { formulas: Grid }>) =>
          Object.values(all)
            .flatMap((tab) => tab.formulas.flat())
            .filter((cell) => typeof cell === "string" && cell.startsWith("=")).length;

        // import the fixture
        const imported = await call("sheet-import-xlsx", {
          sourcePath: `/in/tracker-${ctx.nonce}.xlsx`,
          path: `/imported-${ctx.nonce}.sheet.json`,
          title: "Imported tracker",
        });
        const object = asRecord(imported.object);
        const id = asString(object.id, "imported sheet id");
        expect(
          object.kind === "sheet" &&
            object.path === `imported-${ctx.nonce}.sheet.json` &&
            object.title === "Imported tracker" &&
            JSON.stringify(imported.dropped) === "[]" &&
            typeof imported.link === "string" &&
            imported.link.endsWith(`imported-${ctx.nonce}.sheet.json`),
          `sheet-import-xlsx: ${JSON.stringify(imported).slice(0, 400)}`,
        );
        const first = await readAll(id);
        expect(
          JSON.stringify(Object.keys(first)) === `["Tasks","Summary"]` &&
            formulaCount(first) === 120,
          `imported: tabs ${Object.keys(first)}, formulas ${formulaCount(first)}`,
        );
        // Every formula's recomputed value equals the result cached in the file.
        const original = XLSX.read(tracker, { type: "array", cellFormula: true });
        let matching = 0;
        for (const name of original.SheetNames) {
          for (const [ref, cell] of Object.entries(original.Sheets[name] ?? {})) {
            const c = cell as XLSX.CellObject;
            if (ref.startsWith("!") || !c.f) continue;
            const at = XLSX.utils.decode_cell(ref);
            const got = first[name]?.values[at.r]?.[at.c];
            const want = c.v;
            if (
              typeof want === "number" && typeof got === "number"
                ? Math.abs(want - got) <= 1e-9 * Math.max(1, Math.abs(want))
                : want === got
            ) {
              matching++;
            }
          }
        }
        expect(matching === 120, `${matching} of 120 formulas match the file's cached values`);

        // export, then check the bytes are a real workbook
        const exported = await call("sheet-export-xlsx", {
          id,
          targetPath: `/exported-${ctx.nonce}.xlsx`,
        });
        expect(
          exported.path === `exported-${ctx.nonce}.xlsx` &&
            JSON.stringify(exported.dropped) === "[]" &&
            typeof exported.link === "string" &&
            exported.link.endsWith(`exported-${ctx.nonce}.xlsx`),
          `sheet-export-xlsx: ${JSON.stringify(exported)}`,
        );
        const stored = fake.files.get(`exported-${ctx.nonce}.xlsx`);
        expect(stored?.bytes && stored.bytes[0] === 0x50 && stored.bytes[1] === 0x4b, "a zip file");
        const reread = XLSX.read(stored?.bytes as Uint8Array, { type: "array", cellFormula: true });
        const cachedInExport = reread.SheetNames.flatMap((name) =>
          Object.entries(reread.Sheets[name] ?? {}).filter(
            ([ref, cell]) => !ref.startsWith("!") && (cell as XLSX.CellObject).f,
          ),
        );
        expect(
          JSON.stringify(reread.SheetNames) === `["Tasks","Summary"]` &&
            cachedInExport.length === 120,
          `exported file: ${reread.SheetNames}, ${cachedInExport.length} formulas`,
        );

        // re-import the export: tabs, values and the formula count are unchanged
        const again = await call("sheet-import-xlsx", {
          sourcePath: `exported-${ctx.nonce}.xlsx`,
          path: `again-${ctx.nonce}.sheet.json`,
        });
        const second = await readAll(asString(asRecord(again.object).id, "re-imported id"));
        expect(
          JSON.stringify(Object.keys(second)) === JSON.stringify(Object.keys(first)) &&
            JSON.stringify(second) === JSON.stringify(first) &&
            formulaCount(second) === 120,
          "re-imported workbook differs from the first import",
        );

        // an export is create-only unless overwrite
        expect(
          (
            await refused("sheet-export-xlsx", { id, targetPath: `exported-${ctx.nonce}.xlsx` })
          ).includes("pass overwrite: true"),
          "export onto an existing file is refused",
        );
        await call("sheet-export-xlsx", {
          id,
          targetPath: `exported-${ctx.nonce}.xlsx`,
          overwrite: true,
        });
        expect(fake.files.get(`exported-${ctx.nonce}.xlsx`)?.version === 2, "overwrite writes v2");

        // what a sheet cannot hold is named, both ways
        seed(`in/rich-${ctx.nonce}.xlsx`, await fixture("rich-budget.xlsx"));
        const rich = await call("sheet-import-xlsx", {
          sourcePath: `in/rich-${ctx.nonce}.xlsx`,
          path: `rich-${ctx.nonce}.sheet.json`,
        });
        const dropped = rich.dropped as string[];
        expect(
          ["charts", "comments", "frozen panes", "defined names"].every((x) => dropped.includes(x)),
          `import dropped: ${dropped}`,
        );
        const richId = asString(asRecord(rich.object).id, "rich id");
        const budget = await call("sheet-get-range", { id: richId, range: "Budget!E3:E4" });
        expect(JSON.stringify(budget.values) === "[[-750],[300]]", "formulas with no cached value");
        await call("sheet-set-range", {
          id: richId,
          range: "Budget!H1",
          values: [["=SEQUENCE(2)"]],
        });
        await call("sheet-set-range", { id: richId, range: "Budget!J1", values: [["=1/0"]] });
        const spilled = await call("sheet-export-xlsx", {
          id: richId,
          targetPath: `rich-out-${ctx.nonce}.xlsx`,
        });
        expect(
          (spilled.dropped as string[]).some((x) => x.startsWith("spilled array cells")),
          `export dropped: ${spilled.dropped}`,
        );
        const richOut = XLSX.read(
          fake.files.get(`rich-out-${ctx.nonce}.xlsx`)?.bytes as Uint8Array,
          {
            type: "array",
          },
        );
        expect(
          richOut.Sheets.Budget?.J1?.t === "e" && richOut.Sheets.Budget?.J1?.w === "#DIV/0!",
          "an error result is exported as an error cell",
        );

        // an agent-fs conflict on every write after the create: the tabs are not written, and the message says so
        const partial = `partial-${ctx.nonce}.sheet.json`;
        fake.beforeWrite((target) => {
          const current = fake.files.get(target);
          if (target === partial && current) {
            fake.files.set(target, { body: current.body, version: current.version + 1 });
          }
        });
        const half = await refused("sheet-import-xlsx", {
          sourcePath: `in/rich-${ctx.nonce}.xlsx`,
          path: partial,
        });
        fake.beforeWrite(undefined);
        expect(
          half.includes(`created ${partial}`) &&
            half.includes("could not write the imported tabs") &&
            half.includes("concurrent writers"),
          `a failed write after the create: ${half}`,
        );

        // error and boolean constants import as text and as a boolean
        const constants = XLSX.utils.aoa_to_sheet([[1]]);
        constants.B1 = { t: "e", v: 42, w: "#N/A" };
        constants.C1 = { t: "b", v: true };
        constants["!ref"] = "A1:C1";
        seed(`in/constants-${ctx.nonce}.xlsx`, workbook([["K", constants]]));
        const kept = await call("sheet-import-xlsx", {
          sourcePath: `in/constants-${ctx.nonce}.xlsx`,
          path: `constants-${ctx.nonce}.sheet.json`,
        });
        expect(
          (kept.dropped as string[]).includes("error constants (kept as text)"),
          `constants: ${JSON.stringify(kept.dropped)}`,
        );
        const keptId = asString(asRecord(kept.object).id, "constants id");
        expect(
          JSON.stringify((await call("sheet-get-range", { id: keptId, range: "A1:C1" })).values) ===
            `[[1,"#N/A",true]]`,
          "error constants become text, booleans stay booleans",
        );

        // refusals: nothing is created
        const before = await sheetCount();
        seed(`in/notes-${ctx.nonce}.xlsx`, new TextEncoder().encode("a,b\n1,2\n"));
        seed(`in/data-${ctx.nonce}.csv`, new TextEncoder().encode("a,b"));
        seed(`in/cells-${ctx.nonce}.xlsx`, workbook([["Big", grid(501, 100)]]));
        seed(
          `in/tabs-${ctx.nonce}.xlsx`,
          workbook(Array.from({ length: 21 }, (_, i) => [`T${i + 1}`, grid(1, 1)])),
        );
        seed(`in/huge-${ctx.nonce}.xlsx`, new Uint8Array(5 * 1024 * 1024 + 1));
        seed(
          `in/bomb-${ctx.nonce}.xlsx`,
          declareSize(tracker, "xl/worksheets/sheet1.xml", 17 * 1024 * 1024),
        );
        const fullText = Array.from({ length: 170 }, (_, i) => [String(i).padEnd(32_000, "x")]);
        seed(`in/text-${ctx.nonce}.xlsx`, workbook([["Text", XLSX.utils.aoa_to_sheet(fullText)]]));
        const garbage = zipOf({
          "[Content_Types].xml": "<Types/>",
          "xl/workbook.xml": "<workbook><sheets><sheet",
        });
        seed(`in/garbage-${ctx.nonce}.xlsx`, garbage);
        seed(`in/method-${ctx.nonce}.xlsx`, withMethod(garbage, 12));
        seed(`in/lying-${ctx.nonce}.xlsx`, declareSize(tracker, "xl/worksheets/sheet1.xml", 10));
        const importRefusal = (name: string, path = `x-${ctx.nonce}.sheet.json`) =>
          refused("sheet-import-xlsx", { sourcePath: name, path });
        for (const [source, expected, label] of [
          [`in/notes-${ctx.nonce}.xlsx`, "not an xlsx workbook", "a text file named .xlsx"],
          [`in/data-${ctx.nonce}.csv`, "must end in .xlsx", "a csv"],
          [`in/missing-${ctx.nonce}.xlsx`, "no file at", "a missing file"],
          [`in/huge-${ctx.nonce}.xlsx`, "5 MiB", "over the file size limit"],
          [`in/cells-${ctx.nonce}.xlsx`, "the limit is 50000", "over the cell limit"],
          [`in/tabs-${ctx.nonce}.xlsx`, "the limit is 20", "over the tab limit"],
          [`in/bomb-${ctx.nonce}.xlsx`, "inflates to more than", "a zip bomb"],
          [
            `in/lying-${ctx.nonce}.xlsx`,
            "corrupt zip archive",
            "a directory that understates a part",
          ],
          [`in/method-${ctx.nonce}.xlsx`, "unsupported zip compression method 12", "bzip2 parts"],
          [
            `in/garbage-${ctx.nonce}.xlsx`,
            "not an xlsx workbook",
            "a workbook part SheetJS cannot read",
          ],
          [
            `in/text-${ctx.nonce}.xlsx`,
            "5 MiB",
            "a workbook that fits as xlsx but not as a 5 MiB sheet",
          ],
        ] as const) {
          const reason = await importRefusal(source);
          expect(reason.includes(expected), `import refusal: ${label}: ${reason.slice(0, 200)}`);
        }
        expect(
          (await importRefusal(`in/notes-${ctx.nonce}.xlsx`, "x.json")).includes(".sheet.json"),
          "import needs a .sheet.json target",
        );
        expect(
          (
            await importRefusal(`in/tracker-${ctx.nonce}.xlsx`, `imported-${ctx.nonce}.sheet.json`)
          ).includes("already exists"),
          "import is create-only",
        );
        expect((await sheetCount()) === before, "a refused import creates no sheet");
        expect(
          ![...fake.files.keys()].some((p) => p.startsWith("x-")),
          "a refused import writes no file",
        );

        // export refusals
        expect(
          (await refused("sheet-export-xlsx", { id: "no-such-id", targetPath: "e.xlsx" })).includes(
            "no object",
          ),
          "export of an unknown sheet id",
        );
        expect(
          (await refused("sheet-export-xlsx", { id, targetPath: "e.csv" })).includes(
            "must end in .xlsx",
          ),
          "export needs an .xlsx target",
        );
        expect(
          (await refused("sheet-export-xlsx", { targetPath: "e.xlsx" })).includes(
            "pass `id` or `path`",
          ),
          "export needs an id or path",
        );
        const board = asRecord(
          asRecord(
            await call("object-create", { kind: "board", path: `b-${ctx.nonce}.excalidraw` }),
          ).object,
        );
        expect(
          (
            await refused("sheet-export-xlsx", {
              id: asString(board.id, "board id"),
              targetPath: "b.xlsx",
            })
          ).includes("is a board, not a sheet"),
          "export of a board",
        );
        expect(
          !fake.files.has("e.xlsx") && !fake.files.has("b.xlsx"),
          "refused exports write nothing",
        );

        // a hand-edited file: a cell with only a format exports, a tab name Excel forbids is refused
        const handEdited = async (name: string, tabs: unknown[]) => {
          const path = `hand-${name}-${ctx.nonce}.sheet.json`;
          const made = await call("sheet-create", { path });
          const stored = fake.files.get(path);
          expect(stored, "stored sheet");
          const file = JSON.parse(stored.body);
          file.tabs = tabs;
          fake.files.set(path, { body: JSON.stringify(file), version: stored.version + 1 });
          return asString(asRecord(made.object).id, "hand-edited id");
        };
        const formatOnly = await handEdited("format", [
          { name: "Good", cells: { A1: { v: 1 }, B1: { nf: "0.00" } } },
        ]);
        const okExport = await call("sheet-export-xlsx", {
          id: formatOnly,
          targetPath: `hand-${ctx.nonce}.xlsx`,
        });
        expect(JSON.stringify(okExport.dropped) === "[]", "a format-only cell exports");
        const badName = await handEdited("name", [{ name: "a:b", cells: {} }]);
        expect(
          (
            await refused("sheet-export-xlsx", { id: badName, targetPath: "bad-name.xlsx" })
          ).includes("cannot export tab 'a:b'"),
          "a tab name Excel forbids",
        );
        expect(!fake.files.has("bad-name.xlsx"), "the refused export writes nothing");
      });

      await withMcp(ctx, keyless, async (mcp) => {
        for (const [name, args] of [
          ["sheet-import-xlsx", { sourcePath: "a.xlsx", path: "a.sheet.json" }],
          ["sheet-export-xlsx", { id: "x", targetPath: "a.xlsx" }],
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
