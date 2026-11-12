import { FilesError } from "@/fs/provider";
import { buildAgentFsLiveUrl } from "@/utils/constants";
import { agentFsClientFor } from "../../agent-fs-identity";
import { getDbClient } from "../../db";
import {
  clientFor,
  createObject,
  getObject,
  listObjects,
  NO_AGENT_FS_IDENTITY,
  normalizePath,
  ObjectsError,
  type PrimitiveObject,
} from "../objects";
import {
  A1Error,
  areaOf,
  assertInBounds,
  capToUsed,
  formatRange,
  parseCell,
  parseRange,
  refOf,
} from "./a1";
import { sheetEngine } from "./engine";
import type { EnginePatch } from "./engine-worker";
import {
  checkTabName,
  constantInput,
  emptySheet,
  MAX_CELLS,
  MAX_FILE_BYTES,
  MAX_RANGE_CELLS,
  MAX_TABS,
  newTab,
  type SheetDoc,
  SheetDocSchema,
  type SheetTab,
  usedExtent,
} from "./format";
import { buildXlsx, MAX_XLSX_BYTES, parseXlsx, XLSX_MIME } from "./xlsx";

/** One sheet call: the caller and the file, by `id` or `path`. */
export type SheetTarget = { agentId: string | undefined; id?: string; path?: string };

export type CellInput = number | string | boolean | null;

/** First try plus three retries on an agent-fs 409, then refuse. */
const MAX_ATTEMPTS = 4;

/** Wrap `A1Error` as a refusal the tool layer returns as `toolErr`. */
const refuse = <T>(run: () => T): T => {
  try {
    return run();
  } catch (error) {
    if (error instanceof A1Error) throw new ObjectsError(error.message);
    throw error;
  }
};

/** The workbook's `swarm.id`, or undefined when a save dropped it. */
function embeddedId(content: object): string | undefined {
  const swarm = (content as { swarm?: unknown }).swarm;
  const id = swarm && typeof swarm === "object" ? (swarm as { id?: unknown }).id : undefined;
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

async function load(target: SheetTarget) {
  const { object, missing, content } = await getObject({ ...target, includeContent: true });
  if (object.kind !== "sheet") {
    throw new ObjectsError(`object ${object.id} is a ${object.kind}, not a sheet`);
  }
  if (missing) {
    throw new ObjectsError(
      `the file for ${object.path} is missing on the drive; run object-reindex`,
    );
  }
  if (content && typeof content === "object" && !Array.isArray(content) && !embeddedId(content)) {
    // A save outside the sheet tools (a hand edit, another app) dropped the embedded id.
    throw new ObjectsError(
      `${object.path} has no embedded swarm.id, so a save outside the sheet tools dropped it; run object-reindex (ctx.objects.reindex) with prefix '${object.path}' to write the id back, then retry`,
    );
  }
  const parsed = SheetDocSchema.safeParse(content);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ObjectsError(
      `${object.path} is not a valid swarm-sheet/1 workbook: ${issue?.path.join(".") || "document"}: ${issue?.message}`,
    );
  }
  if (object.fileVersion === null) {
    throw new ObjectsError(`agent-fs returned no version for ${object.path}; cannot write safely`);
  }
  return { object, version: object.fileVersion, doc: parsed.data };
}

/** The exact bytes a sheet file holds, size-checked. Save and the import preflight both use it, so they cannot disagree. */
function sheetBody(doc: SheetDoc): string {
  const body = JSON.stringify(doc, null, 2);
  if (Buffer.byteLength(body) > MAX_FILE_BYTES) {
    throw new ObjectsError(`the sheet would exceed ${MAX_FILE_BYTES} bytes (5 MiB)`);
  }
  return body;
}

async function save(
  agentId: string | undefined,
  object: PrimitiveObject,
  doc: SheetDoc,
  version: number,
  op: string,
) {
  const body = sheetBody(doc);
  const client = agentId ? await agentFsClientFor(agentId) : undefined;
  if (!client) throw new ObjectsError(NO_AGENT_FS_IDENTITY);
  const { orgId, driveId } = client.identity;
  const saved = await client.provider.upload(
    { taskId: "", name: "", key: object.path, orgId, driveId },
    body,
    { contentType: "application/json", ifMatch: String(version), message: `sheet ${op}` },
  );
  // shortcut: agent-fs always returns the new version; if it ever stops, guess version + 1 until the next read corrects it.
  const next = saved.version ? Number(saved.version) : version + 1;
  // The row is a cache of the file (see objects.ts): keep its version close to the file's.
  await getDbClient().run(
    "UPDATE primitive_objects SET fileVersion = ?, updatedAt = ? WHERE id = ?",
    [next, new Date().toISOString(), object.id],
  );
  return next;
}

/**
 * Read, apply, write with `If-Match`. On a 409 read again and re-apply, so edits
 * to different cells merge and the same cell is last writer wins. `apply`
 * returns the new document, or none when nothing changed (no write, no new version).
 */
async function mutate<T>(
  target: SheetTarget,
  op: string,
  apply: (doc: SheetDoc) => Promise<{ doc?: SheetDoc; result: T }>,
): Promise<{ version: number; result: T }> {
  for (let attempt = 1; ; attempt++) {
    const { object, version, doc } = await load(target);
    const { doc: next, result } = await apply(structuredClone(doc));
    if (!next) return { version, result };
    try {
      return { version: await save(target.agentId, object, next, version, op), result };
    } catch (error) {
      if (!(error instanceof FilesError && error.code === "Conflict")) throw error;
      if (attempt >= MAX_ATTEMPTS) {
        throw new ObjectsError(
          `concurrent writers changed ${object.path} ${MAX_ATTEMPTS} times; retry`,
        );
      }
    }
  }
}

function findTab(doc: SheetDoc, name: string | undefined): SheetTab {
  if (name === undefined) return doc.tabs[0] as SheetTab;
  const tab =
    doc.tabs.find((t) => t.name === name) ??
    doc.tabs.find((t) => t.name.toLowerCase() === name.toLowerCase());
  if (!tab) {
    throw new ObjectsError(`no tab '${name}' (tabs: ${doc.tabs.map((t) => t.name).join(", ")})`);
  }
  return tab;
}

/** What a person would type for a value: `=...` is a formula, `'=` escapes a literal, null clears. */
function inputFor(value: CellInput): string {
  if (typeof value !== "string") return constantInput(value);
  if (value.length > 1 && value.startsWith("=")) return value;
  if (value.startsWith("'=")) return value;
  return constantInput(value);
}

/** Recalculate `doc` with `patches` and report which cells moved. */
async function recalc(
  agentId: string | undefined,
  doc: Pick<SheetDoc, "tabs">,
  patches: EnginePatch[],
) {
  const { cells, changed } = await sheetEngine().recalc(doc.tabs, patches, {
    maxCells: MAX_CELLS,
    caller: agentId,
  });
  doc.tabs.forEach((tab, i) => {
    tab.cells = cells[i] ?? {};
  });
  return changed;
}

function checkArea(range: { r1: number; c1: number; r2: number; c2: number }, what: string) {
  const area = areaOf(range);
  if (area > MAX_RANGE_CELLS) {
    throw new ObjectsError(
      `${what} covers ${area} cells; the limit is ${MAX_RANGE_CELLS} per call`,
    );
  }
}

const tabSummary = (tab: SheetTab) => {
  const { rows, cols } = usedExtent(tab);
  return { name: tab.name, rows, cols, freezeRows: tab.freezeRows ?? 0 };
};

export async function createSheet(input: {
  agentId: string | undefined;
  path: string;
  title?: string;
  tabs?: Array<{ name: string; rows?: CellInput[][] }>;
}) {
  const { tabs } = input;
  if (tabs) {
    // Refuse before the file exists, so a bad request leaves nothing behind.
    refuse(() => {
      if (tabs.length === 0 || tabs.length > MAX_TABS)
        throw new A1Error(`tabs: 1-${MAX_TABS} tabs`);
      const seen = new Set<string>();
      for (const tab of tabs) {
        if (seen.has(checkTabName(tab.name).toLowerCase()))
          throw new A1Error(`duplicate tab '${tab.name}'`);
        seen.add(tab.name.toLowerCase());
        const cells = (tab.rows ?? []).reduce((n, row) => n + row.length, 0);
        if (cells > MAX_RANGE_CELLS)
          throw new A1Error(
            `tab '${tab.name}' has ${cells} initial cells; the limit is ${MAX_RANGE_CELLS}`,
          );
      }
    });
  }
  const created = await createObject({
    agentId: input.agentId,
    kind: "sheet",
    path: input.path,
    title: input.title,
  });
  if (!tabs) return { object: created, link: created.link };
  try {
    const { version } = await mutate(
      { agentId: input.agentId, id: created.id },
      "create tabs",
      async (doc) => {
        doc.tabs = tabs.map((t) => newTab(t.name));
        const patches = tabs.flatMap((t) =>
          (t.rows ?? []).flatMap((row, r) =>
            row.map((value, c) => ({
              tab: t.name,
              row: r + 1,
              col: c + 1,
              input: inputFor(value),
            })),
          ),
        );
        await recalc(input.agentId, doc, patches);
        return { doc, result: null };
      },
    );
    return { object: { ...created, fileVersion: version }, link: created.link };
  } catch (error) {
    if (error instanceof ObjectsError) {
      throw new ObjectsError(
        `created ${created.path} (id ${created.id}) but could not write its tabs: ${error.message}`,
      );
    }
    throw error;
  }
}

export async function getSheet(target: SheetTarget) {
  const { object, version, doc } = await load(target);
  return { object, version, tabs: doc.tabs.map(tabSummary) };
}

export const listSheets = (input: {
  agentId: string | undefined;
  prefix?: string;
  limit?: number;
  offset?: number;
}) => listObjects({ ...input, kind: "sheet" });

export async function getSheetRange(target: SheetTarget & { range: string; formulas?: boolean }) {
  const { version, doc } = await load(target);
  const spec = refuse(() => parseRange(target.range));
  const tab = findTab(doc, spec.tab);
  const range = capToUsed(spec, usedExtent(tab));
  if (!range)
    return {
      range: formatRange(tab.name, { ...spec, r2: spec.r1, c2: spec.c1 }),
      values: [],
      version,
    };
  checkArea(range, "the range");
  const values: CellInput[][] = [];
  const formulas: CellInput[][] = [];
  for (let r = range.r1; r <= range.r2; r++) {
    const row: CellInput[] = [];
    const formulaRow: CellInput[] = [];
    for (let c = range.c1; c <= range.c2; c++) {
      const cell = tab.cells[refOf(r, c)];
      const value = cell?.v ?? null;
      row.push(value);
      formulaRow.push(cell?.f ?? value);
    }
    values.push(row);
    formulas.push(formulaRow);
  }
  return {
    range: formatRange(tab.name, range),
    values,
    ...(target.formulas ? { formulas } : {}),
    version,
  };
}

export async function setSheetRange(
  target: SheetTarget & { range: string; values: CellInput[][] },
) {
  const spec = refuse(() => parseRange(target.range));
  if (spec.open)
    throw new ObjectsError(
      "setRange needs a bounded range such as 'Tab!B2:C3', not a whole column or row",
    );
  const rows = target.values.length;
  const cols = Math.max(0, ...target.values.map((row) => row.length));
  if (rows === 0 || cols === 0) throw new ObjectsError("values is empty");
  if (target.values.some((row) => row.length !== cols))
    throw new ObjectsError("values must be a rectangle: every row needs the same length");
  const single = spec.r1 === spec.r2 && spec.c1 === spec.c2;
  // A single cell names the top-left corner; a bigger range must match the values exactly.
  const range = single ? { ...spec, r2: spec.r1 + rows - 1, c2: spec.c1 + cols - 1 } : spec;
  const height = range.r2 - range.r1 + 1;
  const width = range.c2 - range.c1 + 1;
  // Compare both sides: equal area with another shape (1x4 into 2x2) would write outside the named range.
  if (height !== rows || width !== cols) {
    throw new ObjectsError(`values is ${rows}x${cols} but the range is ${height}x${width}`);
  }
  refuse(() => assertInBounds(range));
  checkArea(range, "the range");
  const { version, result } = await mutate(target, "set range", async (doc) => {
    const tab = findTab(doc, spec.tab);
    const patches = target.values.flatMap((row, i) =>
      row.map((value, j) => ({
        tab: tab.name,
        row: range.r1 + i,
        col: range.c1 + j,
        input: inputFor(value),
      })),
    );
    const changed = await recalc(target.agentId, doc, patches);
    const inRange = (ref: string) => {
      const [name, a1] = [ref.slice(0, ref.lastIndexOf("!")), ref.slice(ref.lastIndexOf("!") + 1)];
      const { row, col } = parseCell(a1);
      return (
        name === tab.name &&
        row >= range.r1 &&
        row <= range.r2 &&
        col >= range.c1 &&
        col <= range.c2
      );
    };
    const direct = changed.filter(inRange).length;
    return {
      doc: changed.length ? doc : undefined,
      result: {
        range: formatRange(tab.name, range),
        changed: direct,
        recalculated: changed.length - direct,
      },
    };
  });
  return { ...result, version };
}

export async function appendSheetRows(target: SheetTarget & { tab: string; rows: CellInput[][] }) {
  const cells = target.rows.reduce((n, row) => n + row.length, 0);
  if (cells === 0) throw new ObjectsError("rows is empty");
  if (cells > MAX_RANGE_CELLS)
    throw new ObjectsError(`rows hold ${cells} cells; the limit is ${MAX_RANGE_CELLS} per call`);
  const { version, result } = await mutate(target, "append rows", async (doc) => {
    const tab = findTab(doc, target.tab);
    const first = usedExtent(tab).rows + 1;
    const cols = Math.max(...target.rows.map((row) => row.length));
    const range = { r1: first, c1: 1, r2: first + target.rows.length - 1, c2: cols };
    refuse(() => assertInBounds(range));
    const patches = target.rows.flatMap((row, i) =>
      row.flatMap((value, j) =>
        value === null
          ? []
          : [{ tab: tab.name, row: first + i, col: j + 1, input: inputFor(value) }],
      ),
    );
    const changed = await recalc(target.agentId, doc, patches);
    return {
      doc: changed.length ? doc : undefined,
      result: { range: formatRange(tab.name, range) },
    };
  });
  return { ...result, version };
}

export async function clearSheetRange(target: SheetTarget & { range: string }) {
  const spec = refuse(() => parseRange(target.range));
  const { version, result } = await mutate(target, "clear range", async (doc) => {
    const tab = findTab(doc, spec.tab);
    const range = capToUsed(spec, usedExtent(tab));
    if (!range)
      return {
        result: { range: formatRange(tab.name, { ...spec, r2: spec.r1, c2: spec.c1 }), cleared: 0 },
      };
    checkArea(range, "the range");
    // A spill cell (`s`) is the anchor's output: clearing the anchor removes it.
    const patches = Object.entries(tab.cells).flatMap(([ref, cell]) => {
      const { row, col } = parseCell(ref);
      const inside = row >= range.r1 && row <= range.r2 && col >= range.c1 && col <= range.c2;
      return inside && !cell.s ? [{ tab: tab.name, row, col, input: "" }] : [];
    });
    if (patches.length === 0)
      return { result: { range: formatRange(tab.name, range), cleared: 0 } };
    await recalc(target.agentId, doc, patches);
    return { doc, result: { range: formatRange(tab.name, range), cleared: patches.length } };
  });
  return { ...result, version };
}

export async function addSheetTab(target: SheetTarget & { name: string; after?: string }) {
  const { version, result } = await mutate(target, "add tab", async (doc) => {
    refuse(() => checkTabName(target.name));
    if (doc.tabs.some((t) => t.name.toLowerCase() === target.name.toLowerCase())) {
      throw new ObjectsError(`a tab named '${target.name}' already exists`);
    }
    if (doc.tabs.length >= MAX_TABS)
      throw new ObjectsError(`a sheet holds at most ${MAX_TABS} tabs`);
    const at =
      target.after === undefined
        ? doc.tabs.length
        : doc.tabs.indexOf(findTab(doc, target.after)) + 1;
    doc.tabs.splice(at, 0, newTab(target.name));
    return { doc, result: { tabs: doc.tabs.map((t) => t.name) } };
  });
  return { ...result, version };
}

/** Read an `.xlsx` off the drive. Refuses a missing file or one over the size limit before parsing. */
async function readXlsx(agentId: string | undefined, sourcePath: string): Promise<Uint8Array> {
  if (!/\.xlsx$/i.test(sourcePath)) throw new ObjectsError("sourcePath must end in .xlsx");
  const { provider, scope } = await clientFor(agentId);
  const source = normalizePath(sourcePath);
  let response: Response;
  try {
    response = await provider.download(scope(source));
  } catch (error) {
    if (error instanceof FilesError && error.code === "NotFound") {
      throw new ObjectsError(`no file at '${source}' on this drive`);
    }
    throw error;
  }
  const tooBig = () =>
    new ObjectsError(`${source} is over the ${MAX_XLSX_BYTES} byte limit (5 MiB) for an xlsx`);
  if (Number(response.headers.get("content-length")) > MAX_XLSX_BYTES) {
    await response.body?.cancel();
    throw tooBig();
  }
  // shortcut: a body with no content-length is read whole before the check; agent-fs caps files at 50 MiB.
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length > MAX_XLSX_BYTES) throw tooBig();
  return bytes;
}

/**
 * Import an `.xlsx` from the drive as a new sheet. Parse and recalculate first, so a bad
 * file or an over-limit workbook leaves nothing behind. `dropped` names what the file had
 * that a sheet cannot hold.
 */
export async function importSheetXlsx(input: {
  agentId: string | undefined;
  sourcePath: string;
  path: string;
  title?: string;
}) {
  if (!input.path.endsWith(".sheet.json")) {
    throw new ObjectsError("a sheet path must end with '.sheet.json'");
  }
  const bytes = await readXlsx(input.agentId, input.sourcePath);
  const { tabs, dropped } = await parseXlsx(bytes);
  const draft = { tabs };
  await recalc(input.agentId, draft, []);
  // Size the file createObject writes and save rewrites with these tabs, not a compact stand-in.
  sheetBody({ ...emptySheet(crypto.randomUUID(), input.title), tabs: draft.tabs });
  const created = await createObject({
    agentId: input.agentId,
    kind: "sheet",
    path: input.path,
    title: input.title,
  });
  try {
    const { version } = await mutate(
      { agentId: input.agentId, id: created.id },
      "import xlsx",
      async (doc) => {
        doc.tabs = draft.tabs;
        return { doc, result: null };
      },
    );
    return { object: { ...created, fileVersion: version }, link: created.link, dropped };
  } catch (error) {
    if (error instanceof ObjectsError) {
      throw new ObjectsError(
        `created ${created.path} (id ${created.id}) but could not write the imported tabs: ${error.message}`,
      );
    }
    throw error;
  }
}

/** Export a sheet to an `.xlsx` on the drive. Create-only unless `overwrite`. */
export async function exportSheetXlsx(
  target: SheetTarget & { targetPath: string; overwrite?: boolean },
) {
  if (!/\.xlsx$/i.test(target.targetPath)) throw new ObjectsError("targetPath must end in .xlsx");
  const { object, doc } = await load(target);
  const { bytes, dropped } = await buildXlsx(doc.tabs);
  const { provider, orgId, driveId, scope } = await clientFor(target.agentId);
  const path = normalizePath(target.targetPath);
  try {
    await provider.upload(scope(path), bytes, {
      contentType: XLSX_MIME,
      ifNoneMatch: target.overwrite ? undefined : "*",
      message: `export ${object.path}`,
    });
  } catch (error) {
    if (error instanceof FilesError && error.code === "Conflict") {
      throw new ObjectsError(
        `a file already exists at '${path}'; pass overwrite: true to replace it`,
      );
    }
    throw error;
  }
  return { path, link: buildAgentFsLiveUrl({ orgId, driveId, path }), dropped };
}
