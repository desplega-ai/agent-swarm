/**
 * Shared `@json-render` catalog for every JSON-rendered surface in the SPA.
 *
 * Extracted from `pages/pages/[id]/json-page-renderer.tsx` (where catalog +
 * component impls + action impls used to live in a single file) so that both
 * the DB-backed **pages** renderer and the **swarm-apps** runtime
 * (`/apps/:id`) share one catalog definition.
 *
 * Split:
 *   - `catalog.ts`     — prop/param zod schemas + `swarmCatalog` (this file)
 *   - `components.tsx` — the React implementations (`swarmComponents`)
 *   - `swarm-actions.ts` — the `swarm.sdk` / `swarm.call` handler factory
 *   - `action-params.ts` — row/form scoped param resolution
 *
 * Component set: Container, Card, Heading, Text, Button, Metric, Alert
 * (original pages set — unchanged), Table, Form, Badge (swarm-apps), plus the
 * layout + interactivity tier: Stack, Grid, Split, Divider, Tabs, SearchInput,
 * Select, Markdown.
 * Action set: `swarm.sdk`, `swarm.call` (original) plus `app.mutate`,
 * `app.refresh` (swarm-apps; the pages renderer registers inert stubs).
 *
 * State roots the catalog owns: `/queries/<name>` (runtime), `/forms/<id>`
 * (Form), `/actions/<name>` (runtime) and `/ui/<id>` — the interactivity root
 * written by `SearchInput` / `Select` (`/ui/<id>/value`) and `Tabs`
 * (`/ui/<id>/tab`), which Table's `search` / `filters` bind back to.
 */

import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { z } from "zod";
// Relative (not `@/`) so `scripts/generate-catalog-schema.ts` can run under plain
// `bun run` — bun does not resolve the vite alias from tsconfig.app.json.
import { SWARM_SDK_METHODS, type SwarmSdkMethod } from "../swarm-sdk";

// ─── Action schemas (also exported for the discovery endpoint mirror) ───────

export const swarmSdkActionSchema = z.object({
  sdk: z.enum(SWARM_SDK_METHODS as unknown as [SwarmSdkMethod, ...SwarmSdkMethod[]]),
  args: z.record(z.string(), z.unknown()).optional(),
});

export const swarmCallActionSchema = z.object({
  method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
  endpoint: z.string(),
  body: z.record(z.string(), z.unknown()).optional(),
});

/**
 * `app.mutate` — server-native row CRUD against `/api/apps/:id/models/:model/rows`.
 * `formId` is optional in JSON: the `Form` component injects its own `id` when
 * it dispatches a `create`, so the originating form clears itself on success.
 */
export const appMutateActionSchema = z.object({
  model: z.string(),
  op: z.enum(["create", "update", "delete"]),
  rowId: z.string().optional(),
  values: z.record(z.string(), z.unknown()).optional(),
  formId: z.string().optional(),
});

/** `app.refresh` — refetch one named query (`query`) or all of them. */
export const appRefreshActionSchema = z.object({
  query: z.string().optional(),
});

/**
 * `app.action` — invoke a named custom action declared in the app definition's
 * `actions` map (script- or task-backed) via `POST /api/apps/:id/actions/:name`.
 * The invocation result lands in json-render state at `/actions/<name>` as
 * `{ status: "running"|"ok"|"error", result?, error?, taskId?, taskStatus? }`.
 */
export const appActionActionSchema = z.object({
  name: z.string(),
  input: z.record(z.string(), z.unknown()).optional(),
});

// ─── Component prop schemas ─────────────────────────────────────────────────

/**
 * The one spacing scale every layout primitive shares (gap + padding).
 * `Container`'s narrower legacy scale is deliberately left alone — it predates
 * this token and app JSON in the wild binds to it.
 */
const spacing = z.enum(["none", "xs", "sm", "md", "lg", "xl"]);

export type SpacingToken = z.infer<typeof spacing>;

const containerProps = z.object({
  direction: z.enum(["row", "column"]).optional(),
  gap: z.enum(["none", "sm", "md", "lg"]).optional(),
});

const stackProps = z.object({
  direction: z.enum(["column", "row"]).optional(),
  gap: spacing.optional(),
  align: z.enum(["start", "center", "end", "stretch"]).optional(),
  justify: z.enum(["start", "center", "end", "between"]).optional(),
  wrap: z.boolean().optional(),
  padding: spacing.optional(),
});

/** Grid tracks are capped at 6 — beyond that a page is a table, not a layout. */
const gridColumnCount = z.number().int().min(1).max(6);

const gridProps = z.object({
  columns: z
    .union([
      gridColumnCount,
      z.object({
        base: gridColumnCount.optional(),
        sm: gridColumnCount.optional(),
        md: gridColumnCount.optional(),
        lg: gridColumnCount.optional(),
      }),
    ])
    .optional(),
  gap: spacing.optional(),
});

const splitProps = z.object({
  ratio: z.enum(["1-1", "1-2", "2-1", "1-3", "3-1"]).optional(),
  gap: spacing.optional(),
  collapseBelow: z.enum(["sm", "md", "lg"]).optional(),
  reverse: z.boolean().optional(),
});

const dividerProps = z.object({
  label: z.string().optional(),
});

const tabsTabSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
});

const tabsProps = z.object({
  /** State id — the active tab key is mirrored to `/ui/<id>/tab`. */
  id: z.string(),
  tabs: z.array(tabsTabSchema).min(1),
  defaultTab: z.string().optional(),
});

const searchInputProps = z.object({
  /** State id — the debounced query lands at `/ui/<id>/value`. */
  id: z.string(),
  placeholder: z.string().optional(),
  label: z.string().optional(),
});

const selectOptionSchema = z.union([
  z.string(),
  z.object({ value: z.string(), label: z.string().optional() }),
]);

const selectProps = z.object({
  /** State id — the selected value lands at `/ui/<id>/value`. */
  id: z.string(),
  options: z.array(selectOptionSchema).min(1),
  placeholder: z.string().optional(),
  label: z.string().optional(),
  clearable: z.boolean().optional(),
});

const markdownProps = z.object({
  content: z.string(),
});

const cardProps = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
});

const headingProps = z.object({
  text: z.string(),
  level: z.enum(["h1", "h2", "h3"]).optional(),
});

const textProps = z.object({
  content: z.string(),
  tone: z.enum(["default", "muted"]).optional(),
});

const buttonProps = z.object({
  label: z.string(),
  variant: z.enum(["default", "secondary", "outline", "ghost", "destructive"]).optional(),
});

const metricProps = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
});

const alertProps = z.object({
  message: z.string(),
  tone: z.enum(["info", "success", "warning", "error"]).optional(),
  title: z.string().optional(),
});

/** Status-pill tones map onto the dashboard's semantic status tokens. */
export const BADGE_TONES = [
  "neutral",
  "success",
  "active",
  "error",
  "info",
  "pending",
  "warning",
  "paused",
] as const;

export type BadgeTone = (typeof BADGE_TONES)[number];

const badgeProps = z.object({
  text: z.union([z.string(), z.number()]),
  tone: z.enum(BADGE_TONES).optional(),
});

/**
 * A single action dispatch inside a `rowActions` / `onSubmit` chain. Mirrors
 * `@json-render/core`'s `ActionBinding` but stays loose on `params` because
 * Table/Form resolve the scoped `$row` / `$form` expressions themselves before
 * handing the binding to `ActionProvider.execute` (see `action-params.ts` for
 * why json-render's own `$item` cannot be used here).
 */
const actionChainSchema = z.array(
  z.object({
    action: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
);

const tableColumnSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  /**
   * `badge` renders a status pill; `date` renders a smart relative time.
   * `string` / `enum` are accepted aliases of `text` — agents naturally mirror
   * the MODEL column kinds here, and a mirrored kind must never reject a page.
   */
  kind: z.enum(["text", "string", "number", "boolean", "date", "badge", "enum"]).optional(),
  /** For `kind: "badge"` — cell value → badge tone. Falls back to `neutral`. */
  tones: z.record(z.string(), z.enum(BADGE_TONES)).optional(),
  width: z.number().optional(),
});

/** Copy overrides for a row action's `AlertDialog` confirmation step. */
const tableRowActionConfirmSchema = z.object({
  title: z.string().optional(),
  description: z.string().optional(),
  confirmLabel: z.string().optional(),
});

const tableRowActionSchema = z.object({
  label: z.string(),
  variant: z
    .enum(["default", "secondary", "outline", "ghost", "destructive", "destructive-outline"])
    .optional(),
  /**
   * Gate the action behind an `AlertDialog` (apps/ui/CLAUDE.md: destructive actions
   * MUST confirm — no click-again patterns). Omitted → confirmation is implied
   * for `destructive` / `destructive-outline` variants and skipped otherwise,
   * so a JSON author cannot accidentally ship a one-click delete. `false`
   * opts a destructive-looking-but-reversible action out.
   */
  confirm: z
    .union([
      z.boolean(),
      tableRowActionConfirmSchema,
      // Shorthand: a bare string is the dialog description.
      z.string(),
    ])
    .optional(),
  /** Action chain run per row; params may reference `$row` / `$rowIndex`. */
  actions: actionChainSchema,
});

const tableProps = z.object({
  /** Usually `{ "$state": "/queries/<name>/data" }`. */
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  columns: z.array(tableColumnSchema),
  rowActions: z.array(tableRowActionSchema).optional(),
  /** Usually `{ "$state": "/queries/<name>/loading" }`. */
  loading: z.boolean().optional(),
  /** Usually `{ "$state": "/queries/<name>/error" }`. */
  error: z.string().nullish(),
  emptyMessage: z.string().optional(),
  /**
   * Client-side free-text filter, applied to `data` before render.
   * Usually `{ "$state": "/ui/<searchInputId>/value" }`.
   */
  search: z.string().optional(),
  /**
   * Client-side per-column equality filter, applied to `data` before render.
   * Usually `{ "<column>": { "$state": "/ui/<selectId>/value" } }`.
   */
  filters: z
    .record(z.string(), z.union([z.string(), z.number(), z.boolean()]).nullable())
    .optional(),
});

const formFieldSchema = z.object({
  name: z.string(),
  label: z.string().optional(),
  /** `text` is a multi-line variant of `string` (textarea). */
  kind: z.enum(["string", "text", "number", "boolean", "date", "enum"]).optional(),
  /** Required for `kind: "enum"`. */
  options: z.array(z.string()).optional(),
  placeholder: z.string().optional(),
  required: z.boolean().optional(),
});

const formProps = z.object({
  /** Field values live in json-render state under `/forms/<id>/<field>`. */
  id: z.string(),
  title: z.string().optional(),
  fields: z.array(formFieldSchema),
  submitLabel: z.string().optional(),
  /** Action chain run on submit; params may reference `$form`. */
  onSubmit: actionChainSchema,
});

export type TableColumn = z.infer<typeof tableColumnSchema>;
export type TableRowAction = z.infer<typeof tableRowActionSchema>;
export type TableRowActionConfirm = z.infer<typeof tableRowActionConfirmSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type ActionChain = z.infer<typeof actionChainSchema>;
export type TableFilters = z.infer<typeof tableProps>["filters"];
export type GridColumns = z.infer<typeof gridProps>["columns"];
export type TabsTab = z.infer<typeof tabsTabSchema>;
export type SelectOption = z.infer<typeof selectOptionSchema>;

// ─── Catalog ────────────────────────────────────────────────────────────────

/**
 * The plain catalog spec (zod prop/param schemas + slots + descriptions),
 * exported separately from `swarmCatalog` so `scripts/generate-catalog-schema.ts`
 * can serialize it (via `z.toJSONSchema`) into `src/apps/catalog.generated.json`
 * — the artifact the API server's page validator consumes. Root `src/` must not
 * import this module directly (React peer dep via `@json-render/react`).
 * If you change any schema here, re-run `bun run generate:catalog-schema`.
 */
export const swarmCatalogSpec = {
  components: {
    Stack: {
      props: stackProps,
      slots: ["default"],
      description:
        "THE primary layout primitive — a flex column (default) or row of its children. `gap`/`padding` use the shared spacing scale (none|xs|sm|md|lg|xl, default gap md); `align` is the cross axis, `justify` the main axis, `wrap` lets a row reflow. Use this as the page root and for every section; `Container` is the legacy 2-prop alias kept for older pages.",
    },
    Grid: {
      props: gridProps,
      slots: ["default"],
      description:
        "Responsive grid of equal-width cells, one per child. `columns` is either a single count (1-6) or a per-breakpoint object `{ base, sm, md, lg }` (default `{ base: 1, md: 2, lg: 3 }`) so cards reflow on narrow viewports. Prefer this over a wrapping Stack for card strips and metric tiles.",
    },
    Split: {
      props: splitProps,
      slots: ["default"],
      description:
        "Two-pane layout. POSITIONAL children: the FIRST child is the left pane, the SECOND is the right pane, and any further children stack inside the right pane. `ratio` sizes them (1-1|1-2|2-1|1-3|3-1, default 2-1 = wide left). Below `collapseBelow` (sm|md|lg, default md) the panes stack vertically; `reverse` only flips that stacked order (right pane first on narrow screens).",
    },
    Divider: {
      props: dividerProps,
      description:
        'Horizontal rule between sections, optionally with a centered `label` (e.g. `"Filters"`).',
    },
    Tabs: {
      props: tabsProps,
      slots: ["default"],
      description:
        'Tabbed sections. POSITIONAL children: children[i] is the body of tabs[i], so declare exactly as many children as tabs, in the same order. Only the active tab is visible but every child stays mounted, so polled Tables in background tabs keep their data warm. The active key is mirrored into state at `/ui/<id>/tab`, so other components can bind `{ "$state": "/ui/<id>/tab" }`. `defaultTab` picks the initial key (defaults to the first tab).',
    },
    Container: {
      props: containerProps,
      slots: ["default"],
      description:
        "Legacy flex container (row/column + gap). Prefer `Stack`, which supports the full spacing scale plus alignment, wrapping and padding.",
    },
    Card: {
      props: cardProps,
      slots: ["default"],
      description: "Bordered card with optional title and description.",
    },
    Heading: {
      props: headingProps,
      description: "Text heading (h1/h2/h3).",
    },
    Text: {
      props: textProps,
      description: "Paragraph text.",
    },
    Markdown: {
      props: markdownProps,
      description:
        "Rendered markdown block — headings, lists, links, tables, fenced code. Use it for prose (about/help sections, instructions); use `Text` for a single plain paragraph.",
    },
    SearchInput: {
      props: searchInputProps,
      description:
        'Free-text search box. Writes the debounced (~200ms) query into state at `/ui/<id>/value`; bind it into a Table with `"search": { "$state": "/ui/<id>/value" }`. Purely client-side — it filters rows the page already polled, it does not re-run the query.',
    },
    Select: {
      props: selectProps,
      description:
        'Dropdown filter/picker. `options` are plain strings or `{ value, label }` objects. Writes the chosen value into state at `/ui/<id>/value` (clearing writes `null`); bind it into a Table with `"filters": { "<column>": { "$state": "/ui/<id>/value" } }`. `clearable` (default true) shows a clear button.',
    },
    Button: {
      props: buttonProps,
      description: "Interactive button. Wire to actions via `on.press`.",
    },
    Metric: {
      props: metricProps,
      description: "Single label/value tile for status pages.",
    },
    Alert: {
      props: alertProps,
      description: "Status-toned inline alert.",
    },
    Badge: {
      props: badgeProps,
      description: "Status pill (uppercase tag chip) with a semantic tone.",
    },
    Table: {
      props: tableProps,
      description:
        'Data table. Bind `data`/`loading`/`error` to a named query (`/queries/<name>/...`). `rowActions` chains receive `{ "$row": "<col>" }` (or `{ "$row": "" }` for the whole row) and `{ "$rowIndex": true }`. Destructive row actions always confirm via a dialog; override the copy with `confirm: { title, description, confirmLabel }`. `search` (case-insensitive substring across every listed column) and `filters` (per-column equality, `null`/`""` disables one) narrow the polled rows client-side — bind them to a `SearchInput` / `Select` via `/ui/<id>/value`, or pin a constant (e.g. `"filters": { "pinned": true }`).',
    },
    Form: {
      props: formProps,
      description:
        'Field form. Values live in state under `/forms/<id>/<field>`; `onSubmit` chains receive `$form` (all collected values) and `$form: "<field>"` for one.',
    },
  },
  actions: {
    "swarm.sdk": {
      params: swarmSdkActionSchema,
      description: "Invoke a method on the in-SPA Swarm SDK with the viewer's bearer.",
    },
    "swarm.call": {
      params: swarmCallActionSchema,
      description: "Raw HTTP call to a swarm `/api/*` endpoint with the viewer's bearer.",
    },
    "app.mutate": {
      params: appMutateActionSchema,
      description:
        "Create / update / delete a swarm-app row, then refetch every named query on the same model.",
    },
    "app.refresh": {
      params: appRefreshActionSchema,
      description: "Refetch one named swarm-app query, or all of them when `query` is omitted.",
    },
    "app.action": {
      params: appActionActionSchema,
      description:
        "Invoke a named custom action from the app definition's `actions` map (script- or task-backed). Result lands in state at `/actions/<name>`.",
    },
  },
};

export const swarmCatalog = defineCatalog(schema, swarmCatalogSpec);
