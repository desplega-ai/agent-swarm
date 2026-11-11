/**
 * Worker thread entry for the sheet engine. It holds the IronCalc wasm module
 * and runs one recalculation at a time, so a 10k-cell workbook (about 0.7 s of
 * CPU) never stalls the API event loop.
 *
 * The compiled API binary must list this file as an extra entrypoint
 * (see Dockerfile).
 */
import { initSync, Model } from "@ironcalc/wasm";
import wasmPath from "@ironcalc/wasm/wasm_bg.wasm" with { type: "file" };
import { parseCell, refOf } from "./a1";
import { constantInput, type SheetCell, type SheetTab } from "./format";

declare const self: Worker;

/** `input` is what a person would type: a formula, a constant, or "" to clear the cell. */
export type EnginePatch = { tab: string; row: number; col: number; input: string };
export type EngineRequest = {
  id: number;
  tabs: SheetTab[];
  patches: EnginePatch[];
  /** Refuse when the recalculated workbook (spills included) holds more cells. */
  maxCells: number;
};
export type EngineMessage =
  | { type: "ready" }
  | {
      type: "result";
      id: number;
      /** New `cells` per tab, same order as the request. */
      cells: Array<Record<string, SheetCell>>;
      /** Every `Tab!A1` whose stored cell differs from the request's. */
      changed: string[];
    }
  /** `fatal`: a wasm trap, so the instance memory is suspect and the host respawns the worker. */
  | { type: "error"; id?: number; message: string; fatal?: boolean };

const NUMBER = 1;
const BOOLEAN = 4;
const ERROR = 16;
const FULL_PRECISION = "0.00000000000000000";

initSync({ module: await Bun.file(wasmPath).arrayBuffer() });

type Area = { sheet: number; row: number; column: number; width: number; height: number };
const area = (sheet: number, row: number, column: number): Area => ({
  sheet,
  row,
  column,
  width: 1,
  height: 1,
});

function build(tabs: SheetTab[]): Model {
  const model = new Model("sheet", "en", "UTC", "en");
  // Without the pause every setUserInput re-evaluates: 1k cells take 0.9 s, 10k never finish.
  model.pauseEvaluation();
  tabs.forEach((tab, i) => {
    if (i > 0) model.newSheet();
    model.renameSheet(i, tab.name);
  });
  tabs.forEach((tab, sheet) => {
    for (const [ref, cell] of Object.entries(tab.cells)) {
      if (cell.s) continue; // a cached spill cell: the anchor's formula regenerates it
      const { row, col } = parseCell(ref);
      const input = cell.f ?? (cell.e ? "" : constantInput(cell.v));
      if (cell.nf) model.updateRangeStyle(area(sheet, row, col), "num_fmt", cell.nf);
      if (input !== "") model.setUserInput(sheet, row, col, input);
    }
  });
  return model;
}

/** A cell out of an evaluated model, or null when it is empty. */
function read(model: Model, sheet: number, row: number, col: number, spillOf?: string) {
  const content = model.getCellContent(sheet, row, col);
  const display = model.getFormattedCellValue(sheet, row, col);
  if (content === "" && display === "") return null;
  const type = model.getCellType(sheet, row, col);
  const fmt = model.getCellStyle(sheet, row, col).style.num_fmt;
  const nf = fmt && fmt.toLowerCase() !== "general" ? fmt : undefined;
  const cell: SheetCell = {};
  if (content.startsWith("=")) cell.f = content;
  if (type === NUMBER) {
    // A constant's content is the exact text typed. A computed number prints at 9 digits
    // under General, so read it at full precision and round to 14 significant digits.
    const typed = Number(content);
    if (!cell.f && !spillOf && content.trim() !== "" && Number.isFinite(typed)) cell.v = typed;
    else {
      const at = area(sheet, row, col);
      model.updateRangeStyle(at, "num_fmt", FULL_PRECISION);
      const raw = Number(model.getFormattedCellValue(sheet, row, col));
      model.updateRangeStyle(at, "num_fmt", nf ?? "General");
      cell.v = Number.isFinite(raw) ? Number(raw.toPrecision(14)) : display;
    }
  } else if (type === BOOLEAN) cell.v = display === "TRUE";
  else {
    cell.v = display;
    if (type === ERROR) cell.e = true;
  }
  if (nf) {
    cell.nf = nf;
    cell.t = display;
  }
  if (spillOf) cell.s = spillOf;
  return cell;
}

const FIELDS = ["f", "v", "e", "nf", "t", "s"] as const;
const same = (a: SheetCell | undefined, b: SheetCell | undefined) =>
  FIELDS.every((field) => a?.[field] === b?.[field]) && !!a === !!b;

function recalc(request: EngineRequest) {
  const model = build(request.tabs);
  try {
    return evaluate(model, request);
  } finally {
    model.free();
  }
}

function evaluate(model: Model, { tabs, patches, maxCells }: EngineRequest) {
  const touched = tabs.map(() => new Set<string>());
  for (const patch of patches) {
    const sheet = tabs.findIndex((tab) => tab.name === patch.tab);
    if (sheet < 0) throw new Error(`no such tab: ${patch.tab}`);
    if (patch.input === "")
      model.rangeClearContents(sheet, patch.row, patch.col, patch.row, patch.col);
    else model.setUserInput(sheet, patch.row, patch.col, patch.input);
    touched[sheet]?.add(refOf(patch.row, patch.col));
  }
  model.resumeEvaluation();
  model.evaluate();

  let total = 0;
  const changed: string[] = [];
  const cells = tabs.map((tab, sheet) => {
    const before = tab.cells;
    const keys = new Set([
      ...Object.keys(before).filter((ref) => !before[ref]?.s),
      ...(touched[sheet] ?? []),
    ]);
    const after = new Map<string, SheetCell>();
    const put = (ref: string, cell: SheetCell | null) => {
      if (!cell) return;
      after.set(ref, cell);
      if (++total > maxCells) throw new Error(`the workbook would exceed ${maxCells} cells`);
    };
    for (const ref of keys) {
      const { row, col } = parseCell(ref);
      const cell = read(model, sheet, row, col);
      put(ref, cell);
      const shape = cell?.f ? model.getCellArrayStructure(sheet, row, col) : "SingleCell";
      if (typeof shape === "object" && "DynamicAnchor" in shape) {
        const [width, height] = shape.DynamicAnchor;
        for (let r = row; r < row + height; r++) {
          for (let c = col; c < col + width; c++) {
            if (r !== row || c !== col) put(refOf(r, c), read(model, sheet, r, c, ref));
          }
        }
      }
    }
    // Row-major so the file diffs cleanly.
    const ordered = [...after].sort(([a], [b]) => {
      const p = parseCell(a);
      const q = parseCell(b);
      return p.row - q.row || p.col - q.col;
    });
    for (const [ref, cell] of ordered) {
      if (!same(cell, before[ref])) changed.push(`${tab.name}!${ref}`);
    }
    for (const ref of Object.keys(before)) if (!after.has(ref)) changed.push(`${tab.name}!${ref}`);
    return Object.fromEntries(ordered);
  });
  return { cells, changed };
}

self.onmessage = (event: MessageEvent<EngineRequest>) => {
  const { id } = event.data;
  try {
    const { cells, changed } = recalc(event.data);
    self.postMessage({ type: "result", id, cells, changed } satisfies EngineMessage);
  } catch (error) {
    self.postMessage({
      type: "error",
      id,
      message: error instanceof Error ? error.message : String(error),
      fatal: error instanceof WebAssembly.RuntimeError,
    } satisfies EngineMessage);
  }
};

self.postMessage({ type: "ready" } satisfies EngineMessage);
