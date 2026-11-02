/**
 * Pure helpers for link cells (Table `link` kind and `href` columns,
 * DetailList / CardGrid `link` fields) and tooltip text. Kept free of React
 * and `@/` imports so they stay unit-testable under `bun test`.
 */
import { applyTemplate } from "./apply-template";
import { truncateText } from "./json-preview";

/** Longest text a tooltip shows; past it the text ends in `…`. */
export const TIP_MAX_CHARS = 600;

export interface LinkCellSource {
  /** The cell's own value. */
  value: unknown;
  /** The row (or the record) the cell reads. */
  row: Record<string, unknown>;
  /** Row field holding the URL; without it the cell value is the URL. */
  href?: string;
  /** `{{field}}` template for the text shown instead of the derived label. */
  linkLabel?: string;
  /** Text the cell shows over the link (a column `format`, or the cell value when `href` is set). Omit it to derive the label from the URL. */
  text?: string;
}

export interface LinkCell {
  /** A URL, a root-relative dashboard path or `owner/repo#N`. Null: no link, plain text. */
  target: string | null;
  /** The text to show over the link, or null to let the renderer derive one from the target. */
  label: string | null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * What a link cell links to and shows. `href` names the row field holding the
 * URL, so a PR number cell can link to the PR's `url`. The label is the
 * `linkLabel` template, else `text` (what the cell shows by itself, like a
 * `repo#number` format), else null: the renderer derives it from the target.
 */
export function linkCell(source: LinkCellSource): LinkCell {
  const target = nonEmptyString(source.href ? source.row[source.href] : source.value);
  const templated = source.linkLabel ? applyTemplate(source.linkLabel, source.row).trim() : "";
  const label = templated || (source.text?.trim() ?? "");
  return { target, label: label === "" ? null : label };
}

/** A tooltip's text from a row field value: empty for nothing, a bounded string otherwise. */
export function tipText(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  return truncateText(text.trim(), TIP_MAX_CHARS);
}

/** The slice of an element `isClipped` reads. */
interface Measured {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
}

/** True when the content is wider or taller than the box (text cut by an ellipsis or a line clamp). */
export function isClipped(el: Measured): boolean {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/** The slice of a Table column `cellHasControls` and `isLinkColumn` read. */
export interface ControlColumn {
  kind?: string;
  format?: string;
  href?: string;
}

/** A column whose cell is a smart link (`kind: "link"`, or `href` naming the URL field). */
export function isLinkColumn(column: ControlColumn): boolean {
  return Boolean(column.href) || column.kind === "link";
}

/**
 * True when the cell renders its own controls: a link, a copy button, a
 * switch or a checkbox. A popover trigger must sit beside those, never around them, or the
 * cell would nest one control in another and the inner one would swallow the
 * click. A templated column renders text, so only `href` / `link` count there.
 */
export function cellHasControls(column: ControlColumn): boolean {
  if (isLinkColumn(column)) return true;
  if (column.format) return false;
  return column.kind === "copy" || column.kind === "switch" || column.kind === "checkbox";
}
