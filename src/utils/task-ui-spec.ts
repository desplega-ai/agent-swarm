/**
 * Browser-safe constants and types for task UI specs (json-render chat catalog).
 * No package imports: the dashboard imports this file directly.
 */

/** Max UTF-8 bytes of `JSON.stringify(spec)`. */
export const UI_SPEC_MAX_BYTES = 32_768;

/** Max Slack blocks one spec may render as. */
export const UI_SPEC_MAX_BLOCKS = 45;

/** Max elements in one Slack `actions` block. */
export const UI_SPEC_MAX_ACTIONS_ROW_ELEMENTS = 25;

/** Prefix on the Slack `action_id` of every spec Button. */
export const UI_SPEC_ACTION_PREFIX = "swarm_ui:";

/** Allowed id of a declared action, and of the Button that names it. */
export const UI_SPEC_ACTION_ID = /^[a-z][a-z0-9_]{0,39}$/;

/** Limits passed to `toCard` from `@json-render/chat`. */
export const UI_SPEC_CARD_LIMITS = {
  tables: 1,
  charts: 2,
  chartLabel: 20,
  chartTitle: 50,
  tableRows: 100,
  tableColumns: 20,
} as const;

/** The chat catalog components. Kept equal to `@json-render/chat` by a drift test. */
export const UI_SPEC_COMPONENTS = [
  "Card",
  "Section",
  "Text",
  "Fields",
  "Field",
  "Table",
  "Chart",
  "Divider",
  "Image",
  "Actions",
  "Button",
  "LinkButton",
] as const;

export type UiSpecComponent = (typeof UI_SPEC_COMPONENTS)[number];

export interface TaskUiSpecDocument {
  root: string;
  elements: Record<string, unknown>;
  state?: Record<string, unknown>;
}

export interface TaskUiSpecAction {
  kind: "follow_up";
  prompt: string;
}

export interface TaskUiSpec {
  spec: TaskUiSpecDocument;
  actions?: Record<string, TaskUiSpecAction>;
  fallbackText: string;
}

/** What an agent sends on `store-progress`: the spec without the derived fallback text. */
export type TaskUiSpecInput = Omit<TaskUiSpec, "fallbackText">;
