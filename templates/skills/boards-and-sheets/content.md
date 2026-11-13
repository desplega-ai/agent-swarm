# Boards and sheets

Sheets are spreadsheets with live formulas. Boards are Excalidraw diagrams. Both are files on your default agent-fs drive with a stable object id, so a person can open, edit and comment on them like any other file.

## Pick the format

| The result is... | Use |
|---|---|
| Tabular data that changes over time or needs formulas (tracker, budget, comparison, roll-up) | a sheet (`ctx.sheets`) |
| A diagram or plan someone will move around (flow, architecture, rollout, mind map) | a board (`ctx.boards`) |
| A static table the reader only reads once | a Markdown table in your reply or report |
| A person asked for an Excel file, or sent one | a sheet, plus `importXlsx` / `exportXlsx` |

## How to call

The `sheet-*` and `board-*` MCP tools are off in the agent tool list. Call them from a script: an inline `script-run`, a saved script, a workflow `swarm-script` node or an app script action. All of them get `ctx.sheets` and `ctx.boards`.

- Each method returns the unwrapped result and throws on a refusal (bad range, path exists, limit hit).
- Calls run as your own agent-fs identity on your default drive.
- Identify a file by `id` (from `create` or `list`) or by `path`.
- Writes check the file version and re-apply on a concurrent edit (other cells or elements merge; the same cell or element is last writer wins). After 4 conflicting attempts the call throws "retry".
- `create` and `importXlsx` are create-only: they refuse when the path exists. Read or update the existing file instead.
- Every returned `object` carries `link`, the live app link to the file. Hand that link to the person.

## Where to put files

Put each file under the task's asset key, the `key` in `get-task-details` (for example `shared/q4-planning/`). The drive path equals the key string. Later runs find earlier files there with `ctx.sheets.list({ prefix })` or `ctx.boards.list({ prefix })`.

Sheet paths end in `.sheet.json`. Board paths end in `.excalidraw`.

## Sheets

Limits: 20 tabs, 50,000 non-empty cells and 5 MiB per sheet, 10,000 cells per range call. Tab names are 1-31 characters without `[]:*?/\`.

Value rules for `values` and `rows`:
- A string starting with `=` is a formula. Every write recomputes the workbook.
- Start a string with `'=` to store literal text that begins with `=`.
- Send numbers as numbers. A string such as `"42"` stays text.
- `null` clears a cell in `setRange` and skips it in `appendRows`.

Ranges: `Tasks!B2:C3`, `A1:C10` (first tab), `'My tab'!A:A` (a whole column, capped to the used range) or a single cell `B2`. For `setRange`, a single cell is the top-left corner; a larger range must match the size of `values`.

Create a sheet, add a totals row, read it back:

```ts
export default async function (args, ctx) {
  const dir = "shared/q4-planning/"; // the task's asset key
  const { object, link } = await ctx.sheets.create({
    path: `${dir}tracker.sheet.json`,
    title: "Q4 tracker",
    tabs: [
      {
        name: "Tasks",
        rows: [
          ["Task", "Hours", "Cost"],
          ["Design", 3, "=B2*80"],
          ["Build", 5, "=B3*80"],
        ],
      },
    ],
  });
  await ctx.sheets.appendRows({
    id: object.id,
    tab: "Tasks",
    rows: [["Total", "=SUM(B2:B3)", "=SUM(C2:C3)"]],
  });
  const { values } = await ctx.sheets.getRange({ id: object.id, range: "Tasks!A1:C4" });
  return { id: object.id, link, values }; // values[3] is ["Total", 8, 640]
}
```

Update cells, add a tab, read formulas next to values:

```ts
export default async function (args, ctx) {
  const path = "shared/q4-planning/tracker.sheet.json";
  const write = await ctx.sheets.setRange({ path, range: "Tasks!B2", values: [[4]] });
  await ctx.sheets.addTab({ path, name: "Notes" });
  await ctx.sheets.setRange({ path, range: "Notes!A1", values: [["'=B2 is a cell, not a formula"]] });
  const read = await ctx.sheets.getRange({ path, range: "Tasks!C2:C4", formulas: true });
  const { tabs, version } = await ctx.sheets.get({ path });
  // write.recalculated counts the formulas that changed; read.values is [[320], [400], [720]]
  return { recalculated: write.recalculated, values: read.values, formulas: read.formulas, tabs, version };
}
```

`clearRange({ path, range })` empties a range and recomputes what depends on it.

## xlsx import and export

Import when a person hands you an `.xlsx`; export when they asked for one. The sheet stays the working copy: edit the sheet, then export again.

- `importXlsx({ sourcePath, path })` reads an `.xlsx` on your drive and creates a sheet. It keeps tabs, values, formulas (recomputed), number formats, column widths and merges. Limits: a 5 MiB file, 20 tabs, 50,000 cells; nothing is created when a limit refuses.
- `exportXlsx({ id | path, targetPath, overwrite? })` writes formulas with their cached values, number formats, widths and merges. It refuses an existing `targetPath` unless `overwrite: true`.
- Both return `dropped`: what the other format cannot hold (styles, charts, comments, frozen panes, spilled array cells). Tell the person when `dropped` is not empty.

```ts
export default async function (args, ctx) {
  const dir = "shared/q4-planning/";
  const out = await ctx.sheets.exportXlsx({
    path: `${dir}tracker.sheet.json`,
    targetPath: `${dir}tracker.xlsx`,
    overwrite: true,
  });
  const back = await ctx.sheets.importXlsx({
    sourcePath: `${dir}tracker.xlsx`,
    path: `${dir}tracker-from-xlsx.sheet.json`,
  });
  return { xlsx: out.link, exportDropped: out.dropped, sheet: back.link, importDropped: back.dropped };
}
```

## Boards

Shapes are `rectangle`, `ellipse`, `diamond` or `text`, at most 200 per call. A shape's `key` names it so an arrow in the same call can point at it. An arrow's `from` and `to` take a key from the same call or an existing element id, and both ends bind. Shapes without `x`/`y` are laid out below existing content: `layout` is `row` (default), `column` or `grid`. Colors are `blue`, `green`, `yellow`, `red`, `violet`, `orange`, `gray`, `teal` or `#rrggbb`. A shape grows to fit its label.

Create a board with a flow:

```ts
export default async function (args, ctx) {
  const { object, added } = await ctx.boards.create({
    path: "shared/q4-planning/rollout.excalidraw",
    title: "Rollout plan",
    shapes: [
      { key: "plan", type: "rectangle", label: "Plan" },
      { key: "build", type: "rectangle", label: "Build", color: "blue" },
      { key: "ship", type: "diamond", label: "Ship?", color: "yellow" },
    ],
    arrows: [
      { from: "plan", to: "build" },
      { from: "build", to: "ship", label: "QA green" },
    ],
  });
  return { id: object.id, link: object.link, added }; // added maps plan, build, ship, arrows[0], arrows[1] to element ids
}
```

Read, then edit by element id:

```ts
export default async function (args, ctx) {
  const path = "shared/q4-planning/rollout.excalidraw";
  const { elements } = await ctx.boards.get({ path }); // summary: id, type, text, x, y, width, height, boundTo
  const ship = elements.find((e) => e.text === "Ship?");
  const plan = elements.find((e) => e.text === "Plan");
  const { added } = await ctx.boards.addElements({
    path,
    shapes: [{ key: "rollback", type: "ellipse", label: "Roll back", color: "red" }],
    arrows: [{ from: ship.id, to: "rollback", label: "no" }],
  });
  await ctx.boards.updateElements({ path, patches: [{ elementId: ship.id, label: "Ship to prod?" }] });
  const { removed, version } = await ctx.boards.removeElements({ path, elementIds: [plan.id] });
  return { added, removed, version };
}
```

- `get({ detail: "full" })` returns the raw Excalidraw elements instead of the summary.
- `updateElements` patches `label` (an empty string removes it), `x`, `y`, `width`, `height` and `color`. Bound labels and arrows follow. Arrows take only `label` and `color`.
- `removeElements` sets `isDeleted: true`. A shape takes its label with it and unbinds its arrows.

## Embed in an app or a page

An app shows a live, editable sheet or board with `{ "type": "ObjectEmbed", "props": { "objectId": "<object id>" } }`. A page shows it with this snippet, where `${APP_URL}` is the dashboard origin:

```html
<script type="module" src="${APP_URL}/embed/v1/swarm-object.js"></script>
<swarm-object object-id="<object id>"></swarm-object>
```

Optional attributes: `height` (160-1200 px), `readonly`, and for sheets `tab` and `range` (`B2:F20` or `Tab!B2:F20`). Only signed-in viewers see the object. A public or password page guest sees "sign in to the swarm to view", and a page opened with the shared swarm key is read-only.

## Hand it over quietly

Put the file where the person already works: send its `link` in the thread reply, the report or the task output they asked for. Do not announce sheets or boards as a feature and do not post about them unprompted. If they ask what the link is, say it is an editable spreadsheet or diagram on the shared drive.
