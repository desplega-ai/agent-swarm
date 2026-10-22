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
 * (original pages set — unchanged), Table, Form, Badge (swarm-apps), the
 * layout + interactivity tier: Stack, Grid, Split, Divider, Tabs, SearchInput,
 * Select, Markdown, plus the router tier: Drawer, DetailList, and the Kibo-based
 * data blocks: Kanban, Calendar, ContributionGraph, plus the status /
 * feedback set: Icon, Progress, EmptyState, CopyButton, Kbd, Skeleton,
 * Spinner, AvatarStack, Section, Chips.
 * Action set: `swarm.sdk`, `swarm.call` (original), `ui.toast` (both
 * surfaces) plus `app.mutate`, `app.refresh`, `app.action`, `app.navigate`
 * (swarm-apps; the pages renderer registers inert stubs).
 *
 * State roots the catalog owns: `/queries/<name>` (runtime), `/forms/<id>`
 * (Form), `/actions/<name>` (runtime), `/ui/<id>` — the interactivity root
 * written by `SearchInput` / `Select` / `Chips` (`/ui/<id>/value`) and `Tabs`
 * (`/ui/<id>/tab`), which Table's `search` / `filters` bind back to — and
 * `/route` (runtime): the current router state `{ page, params }`.
 */

import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { z } from "zod";
// Relative (not `@/`) so `scripts/generate-catalog-schema.ts` can run under plain
// `bun run` — bun does not resolve the vite alias from tsconfig.app.json.
import { SWARM_SDK_METHODS, type SwarmSdkMethod } from "../swarm-sdk";
import { ICON_NAMES } from "./icon-names";

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
 * `formId` is optional in JSON: the `Form` component injects its own `id` into
 * every `app.mutate` of its submit chain, so the originating form clears itself
 * on a successful `create` and receives mutate failures inline (the handler
 * writes them to `/forms/<id>/$error` instead of the page-level banner).
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
  /** Task-kind actions only — chains the new task off an existing one. Usually bound from chain scope (`{ "$chain": "leafTaskId" }`) by a component that runs a task chain; a literal or `$state` task id works too. Forwarded to the server unchanged; the server rejects it (400) for script and sync actions. */
  parentTaskId: z.string().optional(),
});

/**
 * One step of an action chain. Mirrors `@json-render/core`'s `ActionBinding`
 * but stays loose on `params` because Table/Form resolve the scoped `$row` /
 * `$form` expressions themselves before handing the binding to
 * `ActionProvider.execute` (see `action-params.ts` for why json-render's own
 * `$item` cannot be used here). Declared up here because `ui.toast`'s
 * `undo.actions` nests a chain.
 */
const actionChainSchema = z.array(
  z.object({
    action: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
);

/**
 * `ui.toast` — show a sonner toast. `undo.actions` is a chain run when the
 * viewer presses the toast's Undo button, through the same handlers as any
 * other chain (so `app.mutate` / `app.action` work there).
 */
export const uiToastActionSchema = z.object({
  message: z.string(),
  description: z.string().optional(),
  tone: z.enum(["success", "error", "info", "warning"]).optional(),
  undo: z
    .object({
      label: z.string().optional(),
      actions: actionChainSchema,
    })
    .optional(),
});

/**
 * `app.navigate` — client-side router navigation to another page of the same
 * app (`/apps/:id/p/<page>?<params>`). `params` REPLACE the current route
 * params wholesale (no merging); values may be `$row` / `$form` sentinels when
 * dispatched from a Table rowAction / Form onSubmit chain. Pushes a history
 * entry, so the browser Back button returns to the previous view.
 */
export const appNavigateActionSchema = z.object({
  page: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

// ─── Component prop schemas ─────────────────────────────────────────────────

/**
 * The one spacing scale every layout primitive shares (gap + padding).
 * `Container`'s narrower legacy scale is deliberately left alone — it predates
 * this token and app JSON in the wild binds to it.
 */
const spacing = z.enum(["none", "xs", "sm", "md", "lg", "xl"]);

/** The curated lucide set (`./icon-names`). Every `icon` prop takes one of these. */
const iconName = z.enum(ICON_NAMES);

/**
 * A single-key shortcut ("/", "n", "?"). Pressing it anywhere on the page
 * (outside text fields, without Ctrl/Cmd/Alt) triggers the control.
 */
const shortcutKey = z.string().min(1).max(12);

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
  /**
   * For `direction: "row"` only: below this breakpoint the row stacks
   * vertically (same semantics as Split.collapseBelow). Filter bars and
   * button rows should set it so they don't crush on phones.
   */
  collapseBelow: z.enum(["sm", "md", "lg"]).optional(),
  /**
   * Entrance motion for the direct children, first mount only. `rise`
   * (default) fades them in and lifts them 4px, staggered; `fade` is opacity
   * only; `none` turns it off.
   */
  motion: z.enum(["rise", "fade", "none"]).optional(),
  /**
   * Grow to fill the remaining space of a `fill`-aware parent (another
   * `fill` Stack/Split) instead of sizing to content, and let its own
   * children do the same. Chain `fill` from the page root down to every
   * container on the path to a scrolling leaf to build a viewport-height
   * layout with no page scroll.
   */
  fill: z.boolean().optional(),
});

/** Grid tracks are capped at 6 — beyond that a page is a table, not a layout. */
const gridColumnCount = z.number().int().min(1).max(6);

/** Responsive column shorthand shared by `Grid.columns` and `CardGrid.columns`. */
const gridColumnsSchema = z.union([
  gridColumnCount,
  z.object({
    base: gridColumnCount.optional(),
    sm: gridColumnCount.optional(),
    md: gridColumnCount.optional(),
    lg: gridColumnCount.optional(),
  }),
]);

const gridProps = z.object({
  /**
   * A bare count is responsive shorthand: 1 column on phones, 2 from `sm`,
   * the declared count from `md` up. The object form pins breakpoints
   * explicitly.
   */
  columns: gridColumnsSchema.optional(),
  gap: spacing.optional(),
  padding: spacing.optional(),
});

const splitProps = z.object({
  ratio: z.enum(["1-1", "1-2", "2-1", "1-3", "3-1"]).optional(),
  gap: spacing.optional(),
  collapseBelow: z.enum(["sm", "md", "lg"]).optional(),
  reverse: z.boolean().optional(),
  padding: spacing.optional(),
  /** Same `fill` contract as `Stack.fill` — grow to fill a `fill`-aware
   * parent's remaining space; both panes stretch to the full row height. */
  fill: z.boolean().optional(),
});

const dividerProps = z.object({
  label: z.string().optional(),
});

const tabsTabSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  icon: iconName.optional(),
  /** Small count pill after the label; a literal or a bound number. */
  count: z.number().optional(),
});

const tabsProps = z.object({
  /** State id — the active tab key is mirrored to `/ui/<id>/tab`. */
  id: z.string(),
  tabs: z.array(tabsTabSchema).min(1),
  defaultTab: z.string().optional(),
  /** `line` (default) is the tab strip; `segmented` is a compact segmented control. */
  variant: z.enum(["line", "segmented"]).optional(),
});

const searchInputProps = z.object({
  /** State id — the debounced query lands at `/ui/<id>/value`. */
  id: z.string(),
  placeholder: z.string().optional(),
  label: z.string().optional(),
  /** Key that focuses the field (usually "/"); shown as a keycap hint. */
  shortcut: shortcutKey.optional(),
});

const chipOptionSchema = z.union([
  z.string(),
  z.object({ value: z.string(), label: z.string().optional(), icon: iconName.optional() }),
]);

const chipsProps = z.object({
  /** State id — the selection lands at `/ui/<id>/value`. */
  id: z.string(),
  options: z.array(chipOptionSchema).min(1),
  /** Several chips at once: the value is a string array instead of one string. */
  multiple: z.boolean().optional(),
  /** Accessible name of the chip group. */
  label: z.string().optional(),
});

const numberInputProps = z.object({
  /** State id — the parsed number lands at `/ui/<id>/value`: `null` when empty; non-numeric text leaves it untouched. */
  id: z.string(),
  label: z.string().optional(),
  placeholder: z.string().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
});

const selectOptionSchema = z.union([
  z.string(),
  z.object({
    value: z.string(),
    label: z.string().optional(),
    icon: iconName.optional(),
    /** Secondary text, right-aligned in the option row (e.g. a role). */
    hint: z.string().optional(),
  }),
]);

const selectProps = z.object({
  /** State id — the selected value lands at `/ui/<id>/value`. */
  id: z.string(),
  options: z.array(selectOptionSchema).min(1),
  placeholder: z.string().optional(),
  label: z.string().optional(),
  clearable: z.boolean().optional(),
  /** Type-to-filter list. On by default once there are more than 8 options. */
  searchable: z.boolean().optional(),
  /** Pick several: the value is a string array instead of one string. */
  multiple: z.boolean().optional(),
  /** Placeholder of the filter field when the list is searchable. */
  searchPlaceholder: z.string().optional(),
  /** Seeds `/ui/<id>/value` the first time it's read (before any user
   * interaction). Ignored once the path has any other value, including `null`.
   * With `multiple` the seed is a one-entry array. */
  defaultValue: z.string().optional(),
});

const treeProps = z.object({
  /** State id — the selected node key lands at `/ui/<id>/value`. */
  id: z.string(),
  nodes: z
    .unknown()
    .describe(
      "json-render flat element map: { root: string | string[], elements: Record<key,{type,children?}> } — usually a {$state} binding to a query row's json column",
    ),
  label: z.string().optional(),
  maxHeight: z
    .string()
    .optional()
    .describe("CSS max-height for the scrollable row list, e.g. '480px' (default '480px')"),
  /** Grow to fill a `fill`-aware parent instead of the fixed `maxHeight` box —
   * the row list scrolls inside whatever height the parent gives it. */
  fill: z.boolean().optional(),
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
  variant: z
    .enum(["default", "secondary", "outline", "ghost", "destructive", "destructive-outline"])
    .optional(),
  /** Constant or bound (e.g. `{ "$state": "/queries/<name>/loading" }`). */
  disabled: z.boolean().optional(),
  /**
   * Name of a custom action from the app definition's `actions` map. While
   * `/actions/<name>/status` is `"running"` the button disables and shows a
   * spinner — pair it with an `on.press` chain dispatching `app.action` for
   * the same name.
   */
  busyWith: z.string().optional(),
  icon: iconName.optional(),
  /** Which side of the label the icon sits on. Defaults to `start`. */
  iconPosition: z.enum(["start", "end"]).optional(),
  /** Shown next to the check for ~1.5s after the `busyWith` action finishes ok. */
  successLabel: z.string().optional(),
  size: z.enum(["sm", "default", "lg"]).optional(),
  /** Single key that presses the button; rendered as a keycap inside it. */
  shortcut: shortcutKey.optional(),
  /** Tooltip shown on hover and focus. */
  hint: z.string().optional(),
});

/** Metric trend: an arrow plus toned text (up = success, down = error, flat = muted). */
const metricTrendSchema = z.object({
  direction: z.enum(["up", "down", "flat"]),
  label: z.string(),
});

const alertProps = z.object({
  message: z.string(),
  tone: z.enum(["info", "success", "warning", "error"]).optional(),
  title: z.string().optional(),
  /** Overrides the tone's default icon. */
  icon: iconName.optional(),
  /** Renders a button inside the callout that emits the element's `press` event. */
  actionLabel: z.string().optional(),
});

const iconProps = z.object({
  name: iconName,
  size: z.enum(["sm", "md", "lg"]).optional(),
  tone: z.enum(["default", "muted", "success", "warning", "error", "info"]).optional(),
  /** Accessible name. Without it the icon is decorative (hidden from screen readers). */
  label: z.string().optional(),
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
  icon: iconName.optional(),
  /**
   * A lifecycle value (pending, in_progress, completed, failed, ...) renders
   * the dashboard status chip with its icon; any other value falls back to
   * the toned pill.
   */
  status: z.string().optional(),
  /** `tag` (default) uppercase chip, `status` sentence-case pill, `count` numeric pill, `beta` BETA tag. */
  variant: z.enum(["tag", "status", "count", "beta"]).optional(),
  /** Tooltip shown on hover. */
  hint: z.string().optional(),
});

const metricProps = z.object({
  label: z.string(),
  value: z.union([z.string(), z.number()]),
  /** Usually `{ "$state": "/queries/<name>/loading" }` — skeleton while true. */
  loading: z.boolean().optional(),
  icon: iconName.optional(),
  /** Tints the icon tile. */
  tone: z.enum(BADGE_TONES).optional(),
  /** A short line under the value. */
  detail: z.string().optional(),
  /** One-sentence explanation in an info tooltip next to the label. */
  info: z.string().optional(),
  trend: metricTrendSchema.optional(),
});

const progressProps = z.object({
  value: z.number(),
  /** The value that means 100%. Defaults to 100. */
  max: z.number().positive().optional(),
  /** Bar color. Ignored by `ring`, which always draws the done arc. */
  tone: z.enum(BADGE_TONES).optional(),
  label: z.string().optional(),
  variant: z.enum(["bar", "ring"]).optional(),
  /** Show the percent (bar) or `value / max` (ring). Defaults to true. */
  showValue: z.boolean().optional(),
});

const emptyStateProps = z.object({
  icon: iconName.optional(),
  title: z.string(),
  body: z.string().optional(),
  /** Renders a button that emits the element's `press` event. */
  actionLabel: z.string().optional(),
});

const copyButtonProps = z.object({
  value: z.union([z.string(), z.number()]),
  /** Visible text. Without it the button is icon-only. */
  label: z.string().optional(),
});

const kbdProps = z.object({
  keys: z.array(z.string()).min(1),
});

const skeletonProps = z.object({
  shape: z.enum(["line", "block", "rows", "metric", "card"]),
  /** How many lines, rows or tiles. */
  count: z.number().int().min(1).max(20).optional(),
  /** Block height in pixels (`block` only). */
  height: z.number().int().min(8).max(800).optional(),
});

const spinnerProps = z.object({
  variant: z.enum(["ring", "ellipsis", "bars"]).optional(),
  size: z.enum(["sm", "md"]).optional(),
  /** Visible text next to the spinner, also its accessible name. */
  label: z.string().optional(),
});

const avatarStackProps = z.object({
  /** Display names; each becomes an initials avatar. */
  users: z.array(z.string()),
  /** Avatars shown before the `+N` overflow count. Defaults to 4. */
  max: z.number().int().min(1).max(20).optional(),
});

const sectionProps = z.object({
  title: z.string(),
  description: z.string().optional(),
  /** Fold the body under a toggle header. */
  collapsible: z.boolean().optional(),
  /** Initial open state for a collapsible section. Defaults to true. */
  defaultOpen: z.boolean().optional(),
});

const tableColumnSchema = z.object({
  key: z.string(),
  label: z.string().optional(),
  /**
   * `badge` renders a status pill; `date` renders a smart relative time.
   * `string` / `enum` are accepted aliases of `text` — agents naturally mirror
   * the MODEL column kinds here, and a mirrored kind must never reject a page.
   * `json` renders a compact single-line `JSON.stringify` preview (truncated).
   */
  kind: z
    .enum([
      "text",
      "string",
      "number",
      "boolean",
      "date",
      "badge",
      "enum",
      "status",
      "user",
      "agent",
      "relative",
      "duration",
      "progress",
      "copy",
      "switch",
      "link",
      "json",
    ])
    .optional(),
  /** For `kind: "badge"` / `"status"` — cell value → tone. Falls back to `neutral`. */
  tones: z.record(z.string(), z.enum(BADGE_TONES)).optional(),
  width: z.number().optional(),
  /** Pin the column to an edge so it survives horizontal scroll (id, actions). */
  pinned: z.enum(["left", "right"]).optional(),
  /**
   * Combine several row fields into one cell via `{{field}}` placeholders
   * (e.g. `"{{name}} · v{{version}}"`; names match `[\w.]+`, no hyphens or
   * spaces). Overrides `key`-based rendering when set: `key` still anchors
   * the column identity (header fallback, `search`, `filters`), but the
   * displayed text — on desktop and in the phone list — comes from the
   * template, with missing fields substituted as empty strings. `kind` is
   * ignored on a templated column.
   */
  format: z.string().optional(),
  /** Cell alignment. Numbers, durations and progress default to `end`. */
  align: z.enum(["start", "end"]).optional(),
  /** `middle` keeps both ends of long ids and paths visible. Defaults to `end`. */
  truncate: z.enum(["end", "middle"]).optional(),
  /** Icon in the column header. */
  icon: iconName.optional(),
  /** Row field shown as a hover tooltip on the cell. */
  tooltip: z.string().optional(),
  /** For `kind: "progress"` — the value that means 100%. Defaults to 100. */
  max: z.number().positive().optional(),
  /**
   * For `kind: "switch"` — chain run when the switch is flipped. `$row` is the
   * row with this column already set to the new value. Omit it and the switch
   * is read-only.
   */
  onChange: actionChainSchema.optional(),
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
   * opts a destructive-looking-but-reversible action out — but never a chain
   * containing `app.mutate` with `op: "delete"`: row deletes are unrecoverable,
   * so they always confirm.
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
  icon: iconName.optional(),
  /** `menu` moves the action into the row's "More" menu. Defaults to `inline`. */
  placement: z.enum(["inline", "menu"]).optional(),
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
    .record(
      z.string(),
      z
        .union([
          z.string(),
          z.number(),
          z.boolean(),
          // "Cell is one of" — what a multiple `Chips` writes. Empty = filter off.
          z.array(z.union([z.string(), z.number(), z.boolean()])),
        ])
        .nullable(),
    )
    .optional(),
  /**
   * Page the grid instead of one endless scroll region. Defaults to
   * auto-enabling past 200 rows; set `false` to force the scroll region.
   */
  pagination: z.boolean().optional(),
  /** Row density — `compact` tightens row height for dense readouts. */
  density: z.enum(["comfortable", "compact"]).optional(),
  /** Row field holding the stable row id. Defaults to `id`. */
  rowId: z.string().optional(),
  /** Chain run when a row is clicked; params may reference `$row` / `$rowIndex`. */
  onRowClick: actionChainSchema.optional(),
  /**
   * Id of the row to highlight, usually the open Drawer's route param
   * (`{ "$state": "/route/params/<param>" }`).
   */
  selectedId: z.union([z.string(), z.number()]).nullish(),
  /**
   * Phone layout (below 768px). `list` renders one card row per record;
   * `scroll` keeps the grid with horizontal scroll. Defaults to `list`, or to
   * `scroll` when the table has row actions but no `onRowClick`.
   */
  mobile: z.enum(["list", "scroll"]).optional(),
  /** Which columns fill the phone row. Defaults to the first text and status columns. */
  mobileFields: z
    .object({
      title: z.string(),
      subtitle: z.string().optional(),
      meta: z.union([z.string(), z.array(z.string())]).optional(),
      status: z.string().optional(),
    })
    .optional(),
  /** Shown instead of the grid when there are no rows. Overrides `emptyMessage`. */
  emptyState: z
    .object({
      icon: iconName.optional(),
      title: z.string(),
      body: z.string().optional(),
    })
    .optional(),
});

const formFieldSchema = z.object({
  /** `$`-prefixed names are reserved runtime slots under `/forms/<id>/` —
   * `$error` holds the inline mutate failure, and a field stored there would
   * render as (and be clobbered by) the failure state. */
  name: z.string().regex(/^[^$]/, "field names must not start with '$' (reserved)"),
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

const drawerProps = z.object({
  /**
   * Route param driving the open state: the drawer is open exactly when
   * `/route/params/<param>` is set. Opening = an `app.navigate` that sets the
   * param; the built-in close button navigates with the param removed
   * (history REPLACE, so Back never returns to a dismissed drawer).
   */
  param: z.string(),
  title: z.string().optional(),
  description: z.string().optional(),
  side: z.enum(["right", "left"]).optional(),
  size: z.enum(["sm", "md", "lg", "xl"]).optional(),
  /**
   * Buttons in a sticky footer. Same shape and confirm rules as Table
   * `rowActions` (destructive variants confirm; an `app.mutate` delete always
   * confirms), minus `placement`. Chains have no `$row`; read the open record
   * with `$state` (e.g. `/route/params/<param>`).
   */
  actions: z.array(tableRowActionSchema.omit({ placement: true })).optional(),
});

const detailListFieldSchema = z.object({
  /** Property key in the bound `data` object (usually a model column name). */
  key: z.string(),
  /** Display label; defaults to the key. */
  label: z.string().optional(),
  /**
   * Same rendering kinds as Table columns (`badge` → status pill, `date` →
   * smart relative time; `string`/`enum` are aliases of `text`), plus `code`
   * for a monospace block (raw JSON / provenance values).
   */
  kind: z
    .enum([
      "text",
      "string",
      "number",
      "boolean",
      "date",
      "badge",
      "enum",
      "code",
      "status",
      "user",
      "relative",
      "copy",
      "json",
    ])
    .optional(),
  /** For `kind: "badge"` / `"status"` — value → badge tone. Falls back to `neutral`. */
  tones: z.record(z.string(), z.enum(BADGE_TONES)).optional(),
});

const detailListProps = z.object({
  /** Usually `{ "$state": "/queries/<name>/data/0" }` — one record object. */
  data: z.record(z.string(), z.unknown()).nullish(),
  fields: z.array(detailListFieldSchema).min(1),
  /** Shown while `data` is null/undefined (query loading or no match). */
  emptyMessage: z.string().optional(),
  /** Label/value pairs flow into 1 (default) or 2 columns. */
  columns: z.union([z.literal(1), z.literal(2)]).optional(),
  /**
   * Usually `{ "$state": "/queries/<name>/loading" }` — skeleton fields while
   * true and `data` is still missing, instead of a premature `emptyMessage`.
   */
  loading: z.boolean().optional(),
});

const kanbanColumnSchema = z.union([
  z.string(),
  z.object({
    /** Value stored in `columnField` for cards in this column. */
    id: z.string(),
    /** Header label; defaults to `id`. */
    label: z.string().optional(),
  }),
]);

const kanbanProps = z.object({
  /** Usually `{ "$state": "/queries/<name>/data" }` — one card per row. */
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Usually `{ "$state": "/queries/<name>/loading" }`. */
  loading: z.boolean().optional(),
  /** Row field holding the card's column (usually an enum column). */
  columnField: z.string(),
  /** Columns in display order. Rows whose value matches none are not shown. */
  columns: z.array(kanbanColumnSchema).min(1),
  /** Row field rendered as the card title. */
  titleField: z.string(),
  /** Extra fields shown under the title, with Table column kinds. */
  cardFields: z.array(detailListFieldSchema).optional(),
  /** Row field holding the stable card id. Defaults to `id`. */
  idField: z.string().optional(),
  /**
   * Chain run when a card is dropped in another column. `$row` is the moved
   * row with `columnField` already set to the destination column. Omit it and
   * the board is read-only (no drag).
   */
  onMove: actionChainSchema.optional(),
  /** Chain run when a card is clicked; params may reference `$row`. */
  onCardClick: actionChainSchema.optional(),
});

const calendarProps = z.object({
  /** Usually `{ "$state": "/queries/<name>/data" }` — one event per row. */
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Usually `{ "$state": "/queries/<name>/loading" }`. */
  loading: z.boolean().optional(),
  /** Row field with the event start (ISO date/datetime or epoch ms). */
  startField: z.string(),
  /** Row field with the event end. Omitted → single-day events on `startField`. */
  endField: z.string().optional(),
  /** Row field rendered as the event label. */
  titleField: z.string(),
  /** Row field holding the stable event id. Defaults to `id`. */
  idField: z.string().optional(),
  /** Chain run when an event is clicked; params may reference `$row`. */
  onSelect: actionChainSchema.optional(),
});

const contributionGraphProps = z.object({
  /** Usually `{ "$state": "/queries/<name>/data" }`. */
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Usually `{ "$state": "/queries/<name>/loading" }`. */
  loading: z.boolean().optional(),
  /** Row field with the date (ISO date/datetime or epoch ms). Defaults to `date`. */
  dateField: z.string().optional(),
  /** Numeric row field summed per day. Omitted → each row counts as 1. */
  countField: z.string().optional(),
  /** Trailing window in days, ending today. Defaults to 365. */
  days: z.number().int().min(7).max(730).optional(),
});

const cardGridFieldSchema = z.object({
  /** Property key in the bound row object. Meta fields render unlabeled, so there is no `label` prop. */
  key: z.string(),
  /**
   * One of `text`, `string`, `enum`, `number`, `boolean`, `date` (smart
   * relative time), `badge` (status pill) or `json` (truncated single-line
   * preview). Without a kind, an object/array value renders like `json`.
   */
  kind: z.enum(["text", "string", "number", "boolean", "date", "badge", "enum", "json"]).optional(),
  /** For `kind: "badge"` — value → badge tone. Falls back to `neutral`. */
  tones: z.record(z.string(), z.enum(BADGE_TONES)).optional(),
});

const cardGridProps = z.object({
  /** Usually `{ "$state": "/queries/<name>/data" }`. */
  data: z.array(z.record(z.string(), z.unknown())).optional(),
  /** Row field rendered as the card title. */
  titleKey: z.string(),
  /**
   * Row field holding an absolute http(s) image URL. Omit it for cards with
   * no image tile; when set, any other per-row value or a failed load
   * renders a placeholder tile.
   */
  imageKey: z.string().optional(),
  /** Secondary metadata rendered under the title (e.g. created date, author), joined inline with `·`. */
  fields: z.array(cardGridFieldSchema).optional(),
  /** Same responsive shorthand as `Grid.columns` (default `{ base: 1, sm: 2, md: 3 }`). */
  columns: gridColumnsSchema.optional(),
  /** Action chain run when a card is clicked. Params may reference `$row` / `$rowIndex`. */
  onClick: actionChainSchema.optional(),
  /** Usually `{ "$state": "/queries/<name>/loading" }`. */
  loading: z.boolean().optional(),
  /** Usually `{ "$state": "/queries/<name>/error" }`. */
  error: z.string().nullish(),
  emptyMessage: z.string().optional(),
});

const elementRefProps = z.object({
  app: z.string().optional(),
  element: z.string(),
  props: z.record(z.string(), z.unknown()).optional(),
  instanceKey: z.string().optional(),
});

const elementSlotProps = z.object({});

export type TableColumn = z.infer<typeof tableColumnSchema>;
export type TableRowAction = z.infer<typeof tableRowActionSchema>;
export type TableRowActionConfirm = z.infer<typeof tableRowActionConfirmSchema>;
export type FormField = z.infer<typeof formFieldSchema>;
export type ActionChain = z.infer<typeof actionChainSchema>;
export type TableFilters = z.infer<typeof tableProps>["filters"];
export type GridColumns = z.infer<typeof gridProps>["columns"];
export type TabsTab = z.infer<typeof tabsTabSchema>;
export type SelectOption = z.infer<typeof selectOptionSchema>;
export type DetailListField = z.infer<typeof detailListFieldSchema>;
export type CardGridField = z.infer<typeof cardGridFieldSchema>;
export type DrawerProps = z.infer<typeof drawerProps>;
export type KanbanColumn = z.infer<typeof kanbanColumnSchema>;
export type ChipOption = z.infer<typeof chipOptionSchema>;
export type DrawerAction = NonNullable<z.infer<typeof drawerProps>["actions"]>[number];
export type MetricTrend = z.infer<typeof metricTrendSchema>;
export type UiToastParams = z.infer<typeof uiToastActionSchema>;

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
        "THE primary layout primitive \u2014 a flex column (default) or row of its children. `gap`/`padding` use the shared spacing scale (none|xs|sm|md|lg|xl, default gap md); `align` is the cross axis, `justify` the main axis, `wrap` lets a row reflow. For rows, set `collapseBelow` (sm|md|lg) so the row stacks vertically on narrow viewports \u2014 filter bars should always set it. `motion` (rise|fade|none, default rise) is the entrance of the direct children on first paint: a 200ms fade plus a 4px rise, staggered 30ms; it never replays on data polls, nested Stacks inherit the parent's entrance, and reduced-motion viewers get a short fade. Use this as the page root and for every section; `Container` is the legacy 2-prop alias kept for older pages. `fill: true` makes this Stack grow to fill the remaining height of a `fill`-aware parent instead of sizing to content — chain it from the page root down to a scrolling leaf to build a viewport-height layout with no page scroll; a non-`fill` sibling keeps its natural height and the `fill` sibling absorbs whatever is left.",
    },
    Grid: {
      props: gridProps,
      slots: ["default"],
      description:
        "Responsive grid of equal-width cells, one per child. `columns` is either a single count (1-6) — responsive shorthand: 1 column on phones, 2 from `sm`, the count from `md` up — or a per-breakpoint object `{ base, sm, md, lg }` (default `{ base: 1, md: 2, lg: 3 }`). Prefer this over a wrapping Stack for card strips and metric tiles.",
    },
    Split: {
      props: splitProps,
      slots: ["default"],
      description:
        "Two-pane layout. POSITIONAL children: the FIRST child is the left pane, the SECOND is the right pane, and any further children stack inside the right pane. `ratio` sizes them (1-1|1-2|2-1|1-3|3-1, default 2-1 = wide left). Below `collapseBelow` (sm|md|lg, default md) the panes stack vertically; `reverse` only flips that stacked order (right pane first on narrow screens). `fill: true` makes this Split grow to fill the remaining height of a `fill`-aware parent (same contract as `Stack.fill`) — both panes stretch to the full row height, so nesting a `fill` Split inside one pane of another `fill` Split is the standard way to build a 3+ column viewport-height layout (ratio is only ever 2 panes).",
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
        'Tabbed sections. POSITIONAL children: children[i] is the body of tabs[i], so declare exactly as many children as tabs, in the same order. Only the active tab is visible but every child stays mounted, so polled Tables in background tabs keep their data warm. The active key is mirrored into state at `/ui/<id>/tab`, so other components can bind `{ "$state": "/ui/<id>/tab" }`. `defaultTab` picks the initial key (defaults to the first tab). Tab entries take an optional `icon` and `count` (a small count pill; a literal or a bound number). `variant: "segmented"` renders a compact segmented control instead of the tab strip (same state and warm panels).',
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
        'Free-text search box. Writes the debounced (~200ms) query into state at `/ui/<id>/value`; bind it into a Table with `"search": { "$state": "/ui/<id>/value" }`. Purely client-side \u2014 it filters rows the page already polled, it does not re-run the query. `shortcut` (usually `"/"`) shows a keycap hint and focuses the field when pressed outside a text field.',
    },
    Select: {
      props: selectProps,
      description:
        'Dropdown filter/picker. `options` are plain strings or `{ value, label?, icon?, hint? }` objects. Writes the chosen value into state at `/ui/<id>/value` (clearing writes `null`); bind it into a Table with `"filters": { "<column>": { "$state": "/ui/<id>/value" } }`. `clearable` (default true) shows a clear button. `searchable` adds a type-to-filter field (on by default past 8 options; `searchPlaceholder` sets its hint). `multiple` picks several: the value is a string array (empty = nothing picked), which a Table filter reads as "cell is one of". `defaultValue` seeds `/ui/<id>/value` the first time it is read, before any interaction (a one-entry array with `multiple`).',
    },
    NumberInput: {
      props: numberInputProps,
      description:
        "Labelled numeric text field (decimal keyboard on touch devices, no debounce). Writes the parsed number into state at `/ui/<id>/value` on every change, or `null` when the field is empty; non-numeric text (a bare '-' mid-edit, letters) leaves the stored value untouched until it parses. `min`/`max` clamp the stored value, and the visible text snaps to that clamped value when the field loses focus.",
    },
    Button: {
      props: buttonProps,
      description:
        'Interactive button. Wire to actions via `on.press`. `variant: "destructive-outline"` is the canonical red-outlined destructive look (standalone deletes should use it, not solid red). `disabled` accepts a constant or a bound boolean; `busyWith: "<actionName>"` swaps the label for a spinner (presses ignored) while that custom action is running, then shows a check plus `successLabel` for ~1.5s when it finishes ok. `icon` + `iconPosition` (start|end) add an icon from the curated set; `size` sm|default|lg. `shortcut` (one key, e.g. `"n"`) shows a keycap inside the button and presses it from anywhere on the page (not while typing in a field, not with Ctrl/Cmd/Alt). `hint` is a hover tooltip.',
    },
    Metric: {
      props: metricProps,
      description:
        'Stat tile (the dashboard `StatPanel`): label, value, optional `detail` line and `trend: { direction: "up"|"down"|"flat", label }` (arrow plus success/error/muted text). `icon` adds a tile tinted by `tone` (neutral|success|active|error|info|pending|warning|paused); `info` is a one-sentence explanation in a tooltip next to the label. Bind `loading` to the backing query (`{ "$state": "/queries/<name>/loading" }`) to show a skeleton instead of a blank value while it loads; an empty value renders an em dash.',
    },
    Alert: {
      props: alertProps,
      description:
        "Status-toned inline alert. `icon` overrides the tone's default icon. `actionLabel` adds a button inside the callout that emits the element's `press` event (wire it with `on.press`).",
    },
    Badge: {
      props: badgeProps,
      description:
        "Small chip. `variant`: `tag` (default, the uppercase status chip with a tone dot), `status` (11px sentence-case pill with a dot or icon), `count` (compact rounded numeric pill), `beta` (the BETA tag; `hint` is its tooltip). `tone` is neutral|success|active|error|info|pending|warning|paused; `icon` replaces the dot. `status` takes a lifecycle value (pending, in_progress, completed, failed, cancelled, paused, ...) and renders the dashboard status chip with its icon and label \u2014 any other value falls back to a toned pill showing `text`. `hint` adds a hover tooltip.",
    },
    Icon: {
      props: iconProps,
      description:
        "One icon from the curated lucide set (`plus`, `refresh-cw`, `search`, `filter`, `download`, `upload`, `external-link`, `copy`, `check`, `x`, `trash-2`, `pencil`, `eye`, `calendar`, `clock`, `user`, `users`, `bot`, `git-pull-request`, `git-branch`, `github`, `slack`, `mail`, `link`, `file-text`, `folder`, `database`, `zap`, `sparkles`, `flag`, `star`, `tag`, `alert-triangle`, `info`, `circle-check`, `trending-up`, `trending-down`, `dollar-sign`, `activity`, `rocket`). The same names work on every `icon` prop (Button, Badge, Metric, Alert, Tabs entries, Chips options, EmptyState, Table columns, row actions and Drawer actions). Decorative unless `label` is set. `size` sm|md|lg, `tone` default|muted|success|warning|error|info.",
    },
    Progress: {
      props: progressProps,
      description:
        'Progress readout. `value` against `max` (default 100), usually bound to state. `variant: "bar"` (default) is a toned bar (`tone` neutral|success|active|error|info|pending|warning|paused) with an optional `label` above it; `"ring"` is the dashboard progress ring (done arc). `showValue` (default true) prints the percent (bar) or `value / max` (ring).',
    },
    EmptyState: {
      props: emptyStateProps,
      description:
        "Centered empty state: `icon` (curated set, default inbox), `title`, optional `body`. `actionLabel` adds a button that emits the element's `press` event — wire it with `on.press` like a Button.",
    },
    CopyButton: {
      props: copyButtonProps,
      description:
        "Copies `value` to the clipboard; the icon swaps to a check on copy. `label` is the visible text; without it the button is icon-only.",
    },
    Kbd: {
      props: kbdProps,
      description:
        'Keycaps for a keyboard shortcut, one per entry in `keys` (e.g. `["⌘", "K"]`). Display only.',
    },
    Skeleton: {
      props: skeletonProps,
      description:
        "Loading placeholder. `shape`: `line` (text lines), `block` (one box, `height` in px, default 128), `rows` (table-like rows), `metric` (stat tiles), `card` (a card sketch). `count` repeats lines, rows or tiles. Pair with `visible` on a query's `loading` state.",
    },
    Spinner: {
      props: spinnerProps,
      description:
        'Inline busy indicator with `role=status`. `variant` ring|ellipsis|bars (default: the dashboard spinner), `size` sm|md, `label` shown next to it (and its accessible name; defaults to an sr-only "Loading").',
    },
    AvatarStack: {
      props: avatarStackProps,
      description:
        "Overlapping initials avatars for `users` (display names), up to `max` (default 4) then a `+N` count; hover lists every name.",
    },
    Section: {
      props: sectionProps,
      slots: ["default"],
      description:
        "Titled section around its children: `title`, optional `description`. `collapsible` folds the body under a toggle header (`defaultOpen`, default true).",
    },
    Chips: {
      props: chipsProps,
      description:
        'Toggle chips for quick filters. `options` are strings or `{ value, label?, icon? }`. Writes the selection to `/ui/<id>/value`: one string or `null` (pressing the selected chip clears it), or with `multiple` a string array (empty = nothing picked). Bind it into a Table with `"filters": { "<column>": { "$state": "/ui/<id>/value" } }` — an array filter matches rows whose cell is one of the values. `label` names the group for screen readers.',
    },
    Table: {
      props: tableProps,
      description:
        'Data table. Bind `data`/`loading`/`error` to a named query (`/queries/<name>/...`). `rowActions` chains receive `{ "$row": "<col>" }` (or `{ "$row": "" }` for the whole row) and `{ "$rowIndex": true }`. Destructive row actions always confirm via a dialog; override the copy with `confirm: { title, description, confirmLabel }`. `search` (case-insensitive substring across every listed column) and `filters` (per-column equality, `null`/`""` disables one; an array means "one of", which is what a multiple `Chips` writes, and an empty array disables it) narrow the polled rows client-side — bind them to a `SearchInput` / `Select` via `/ui/<id>/value`, or pin a constant (e.g. `"filters": { "pinned": true }`). Columns take `pinned: "left"|"right"` to survive horizontal scroll; `pagination` pages large row sets (auto past 200 rows); `density: "compact"` tightens row height. Column kinds: `status` (lifecycle values like pending/in_progress/completed/failed get the dashboard status icon, anything else a `tones` pill), `user` / `agent` (avatar + name), `relative` (smart time with the exact time on hover), `duration` (ms → 1m 23s), `progress` (bar, `max` default 100), `copy` (value + copy button), `switch` (runs the column\'s `onChange` chain with `$row` set to the new value; read-only without it), `link` (http(s) URL, opens in a new tab), `json` (compact single-line `JSON.stringify` preview, truncated). Columns also take `align`, `truncate: "middle"` (ids, paths), a header `icon` and `tooltip` (a row field shown on hover), and `format` — a `{{field}}` template (e.g. `"{{name}} · v{{version}}"`) that combines several row fields into one cell and overrides `key`/`kind` rendering on desktop and in the phone list (placeholder names match `[w.]+`, no hyphens or spaces; sorting uses the composed text; `search` and `filters` still read the column\'s `key`). `onRowClick` runs a chain with `$row` when a row is clicked — pair it with `app.navigate` + a Drawer and bind `selectedId` to the drawer param to highlight the open row. `rowId` names the id field (default `id`). Below 768px the table renders as a phone list (`mobile: "list"`, fields picked by `mobileFields: { title, subtitle?, meta?, status? }`); `mobile: "scroll"` keeps the grid. `emptyState: { icon?, title, body? }` replaces the empty message. Row actions take `icon` and `placement: "menu"` (collected into a More menu).',
    },
    Form: {
      props: formProps,
      description:
        'Field form. Values live in state under `/forms/<id>/<field>`; `onSubmit` chains receive `$form` (all collected values) and `$form: "<field>"` for one. `app.mutate` failures in the chain surface inline under the fields (not the page banner), and the submit button shows a pending spinner while the chain runs.',
    },
    Drawer: {
      props: drawerProps,
      slots: ["default"],
      description:
        'Route-driven slide-in side panel (sheet). Open exactly when the route param named by `param` is set \u2014 open it with `app.navigate` (e.g. a rowAction setting `{ "panel": { "$row": "id" } }`), and the URL stays shareable: a deep link with the param renders the drawer open, and closing it clears the param. Children mount only while open (a Table inside does NOT stay warm when closed \u2014 unlike Tabs). `side` right (default) or left; `size` sm|md|lg|xl: about 480/660/900/1010px at a 1440px viewport (md default), growing with the viewport up to 640/960/1280/1600px; full width on phones. `actions: [{ label, icon?, variant?, confirm?, actions }]` render in a sticky footer with the Table rowActions confirm rules (destructive variants confirm, an `app.mutate` delete always confirms); chains have no `$row`, so read the open record id with `{ "$state": "/route/params/<param>" }`.',
    },
    DetailList: {
      props: detailListProps,
      description:
        'Read-only label/value detail view for ONE record. Bind `data` to a single row \u2014 usually `{ "$state": "/queries/<name>/data/0" }` with a `$param`-filtered query. `fields` pick and format properties with the same kinds as Table columns (badge tones, relative dates) plus `status` (lifecycle chip), `user` (avatar + name), `relative` (smart time, exact on hover), `copy` (value + copy button), `code` (monospace block) and `json` (collapsible JSON tree). Bind `loading` to the query (`/queries/<name>/loading`) for skeleton fields while it loads; `emptyMessage` shows when the record is genuinely missing.',
    },
    CardGrid: {
      props: cardGridProps,
      description:
        "Responsive grid of data-bound cards, one per row \u2014 the visual counterpart to `Table` for record browsers (projects, documents, media). Bind `data`/`loading`/`error` to a named query like Table. `titleKey` picks the row field shown as the card title. `imageKey` picks a row field holding an absolute http(s) image URL and adds an image tile to every card (a non-URL value or a failed load shows a placeholder); omit it for text-only cards. `fields` render as an unlabeled `\u00b7`-joined meta line under the title; each field's `kind` is one of `text`, `string`, `enum`, `number`, `boolean`, `date`, `badge` (with `tones`) or `json`. `onClick` is an action chain (params may use `$row` / `$rowIndex`) dispatched on card click or Enter/Space, commonly `app.navigate` into a detail page. `columns` is the same responsive shorthand as `Grid.columns` (default `{ base: 1, sm: 2, md: 3 }`). Renders 200 cards at a time with a Show more button.",
    },
    Kanban: {
      props: kanbanProps,
      description:
        'Kanban board: one card per row, grouped into `columns` by the row\'s `columnField`. Bind `data`/`loading` to a named query. `titleField` is the card title; `cardFields` add label/value lines with the DetailList field kinds (badge tones, status, user, relative, copy, ...). Dragging a card to another column runs `onMove` with `$row` = the moved row, `columnField` already set to the new column — typically `[{ "action": "app.mutate", "params": { "model": "<m>", "op": "update", "rowId": { "$row": "id" }, "values": { "<columnField>": { "$row": "<columnField>" } } } }]`. Without `onMove` the board is read-only. `onCardClick` runs with `$row` (e.g. an `app.navigate` that opens a Drawer).',
    },
    Calendar: {
      props: calendarProps,
      description:
        "Read-only month calendar of rows. `startField` (and optional `endField`) hold dates; an event shows on every day it spans. `titleField` labels it. Has its own prev/next month controls; each Calendar keeps its own month. `onSelect` runs when an event is clicked, with `$row` (e.g. `app.navigate` to open a Drawer).",
    },
    ContributionGraph: {
      props: contributionGraphProps,
      description:
        "GitHub-style activity heatmap over the trailing `days` (default 365). Buckets rows by the calendar day of `dateField` (default `date`); each row counts 1, or sums `countField` when set. Read-only.",
    },
    Tree: {
      props: treeProps,
      description:
        'Collapsible tree view of a json-render flat element map. Bind `nodes` to a doc-shaped value (`{ root: string | string[], elements: Record<key,{type,children?}> }`) — usually `{ "$state": "/queries/<name>/data/0/<jsonColumn>" }`. Each row shows `key — type`; clicking one writes the node key to `/ui/<id>/value`, and the row bound to that path renders selected. A malformed or absent `nodes` value renders an empty state. Rows scroll inside a fixed-height viewport — `maxHeight` overrides the default `480px` — or set `fill: true` to grow inside a `fill`-aware parent and scroll within whatever height that gives it instead (ignores `maxHeight`). Outlines are cut at 2,000 rows with a notice; branches deeper than 32 levels keep a disabled chevron.',
    },
    ElementRef: {
      props: elementRefProps,
      slots: ["default"],
      description:
        "Reference a reusable element from this app or an exported element from another app. Consumer children are inserted at the target's ElementSlot.",
    },
    ElementSlot: {
      props: elementSlotProps,
      description: "Leaf insertion point for children supplied by an ElementRef consumer.",
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
    "ui.toast": {
      params: uiToastActionSchema,
      description:
        'Show a toast: `message`, optional `description`, `tone` success|error|info|warning (default info). `undo: { label?, actions }` adds an Undo button (label defaults to "Undo") that runs `actions` as a chain — e.g. an `app.mutate` that restores the row a delete just removed.',
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
    "app.navigate": {
      params: appNavigateActionSchema,
      description:
        "Navigate to another page of this app (`/apps/:id/p/<page>?<params>`). `params` replace the current route params wholesale and may use `$row` / `$form` sentinels. Pushes a history entry (browser Back returns). The current route is mirrored into state at `/route` as `{ page, params }`.",
    },
  },
};

const {
  ElementRef: _elementRef,
  ElementSlot: _elementSlot,
  ...runtimeComponents
} = swarmCatalogSpec.components;

// ElementRef/ElementSlot are server-valid definition nodes (they belong in the
// GENERATED catalog the API validates against) that the runtime registry must
// never resolve. Since Phase 6 they are expanded away before `<Renderer>` sees
// a spec (`./assemble`), so in principle nothing would reach a registered
// component — the strip stays as belt-and-braces: if an expansion path is ever
// missed, the renderer's unknown-type fallback is a visible no-op instead of a
// silently mounted, propless container pretending the reference worked.
export const swarmCatalog = defineCatalog(schema, {
  components: runtimeComponents,
  actions: swarmCatalogSpec.actions,
});
