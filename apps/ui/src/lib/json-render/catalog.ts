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
 * (original pages set — unchanged) plus Table, Form, Badge (swarm-apps).
 * Action set: `swarm.sdk`, `swarm.call` (original) plus `app.mutate`,
 * `app.refresh` (swarm-apps; the pages renderer registers inert stubs).
 */

import { defineCatalog } from "@json-render/core";
import { schema } from "@json-render/react";
import { z } from "zod";
import { SWARM_SDK_METHODS, type SwarmSdkMethod } from "@/lib/swarm-sdk";

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

// ─── Component prop schemas ─────────────────────────────────────────────────

const containerProps = z.object({
  direction: z.enum(["row", "column"]).optional(),
  gap: z.enum(["none", "sm", "md", "lg"]).optional(),
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
  /** `badge` renders a status pill; `date` renders a smart relative time. */
  kind: z.enum(["text", "number", "boolean", "date", "badge"]).optional(),
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
   * Gate the action behind an `AlertDialog` (ui/CLAUDE.md: destructive actions
   * MUST confirm — no click-again patterns). Omitted → confirmation is implied
   * for `destructive` / `destructive-outline` variants and skipped otherwise,
   * so a JSON author cannot accidentally ship a one-click delete. `false`
   * opts a destructive-looking-but-reversible action out.
   */
  confirm: z.union([z.boolean(), tableRowActionConfirmSchema]).optional(),
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

// ─── Catalog ────────────────────────────────────────────────────────────────

export const swarmCatalog = defineCatalog(schema, {
  components: {
    Container: {
      props: containerProps,
      slots: ["default"],
      description: "Layout container (flex row or column with gap).",
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
        'Data table. Bind `data`/`loading`/`error` to a named query (`/queries/<name>/...`). `rowActions` chains receive `{ "$row": "<col>" }` (or `{ "$row": "" }` for the whole row) and `{ "$rowIndex": true }`. Destructive row actions always confirm via a dialog; override the copy with `confirm: { title, description, confirmLabel }`.',
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
  },
});
