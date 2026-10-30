/**
 * The pure model behind the `SchemaForm` component: derive the controls from an
 * untrusted JSON schema, seed and commit the draft, and merge an edited
 * element's props into a base document ("nested document editing"). React-free
 * so it can be unit-tested without a DOM (`schema-form-model.test.ts`).
 *
 * The schema and the base document are user/agent-authored, so every walk is
 * bounded: at most `SCHEMA_FORM_MAX_PROPERTIES` controls, at most
 * `SCHEMA_FORM_MAX_ENUM_OPTIONS` options per select, and a base document with
 * more than `SCHEMA_FORM_MAX_DOC_ELEMENTS` elements is refused. The merge is a
 * shallow structural-sharing copy (never a deep clone), and value comparison
 * and signatures stop at `SCHEMA_FORM_MAX_VALUE_DEPTH` / `SCHEMA_FORM_MAX_VALUE_NODES`.
 */

import { parseNumberInputValue } from "./number-input-value";

/** Most controls rendered from `schema.properties`; the rest are dropped. */
export const SCHEMA_FORM_MAX_PROPERTIES = 100;
/** Most options rendered for one `enum` property; the rest are dropped. */
export const SCHEMA_FORM_MAX_ENUM_OPTIONS = 200;
/** Most elements in a `baseDoc` the form will merge into; above it the form refuses to edit. */
export const SCHEMA_FORM_MAX_DOC_ELEMENTS = 5000;
/** Deepest nesting `valuesEqual` / `boundedStringify` descend into. */
export const SCHEMA_FORM_MAX_VALUE_DEPTH = 8;
/** Most values `valuesEqual` / `boundedStringify` visit in one call. */
export const SCHEMA_FORM_MAX_VALUE_NODES = 2000;

export type ControlKind = "switch" | "select" | "number" | "text";

export interface FormControl {
  key: string;
  kind: ControlKind;
  /** Only for `select`: the distinct string members of `enum`, capped. */
  options: string[];
  /** Only for `number`: reject decimals (`type: "integer"`). */
  integer: boolean;
  description?: string;
  default?: unknown;
}

export interface FormControls {
  controls: FormControl[];
  /** True when `schema.properties` had more entries than the cap. */
  truncated: boolean;
}

/** A json-render doc: `{ root, elements: { <key>: { type, props?, children? } } }`. */
export interface Doc {
  root?: unknown;
  elements: Record<string, unknown>;
}

export type Draft = Record<string, unknown>;

/**
 * One unconfirmed edit of a node: its latest `props`, plus `seen`, the props
 * the node has held since the edit began (the doc's own props at the first
 * commit, then each earlier overlay). Until `baseDoc` shows `props`, it may
 * still show any `seen` version; anything else means the doc changed under the
 * edit (another document, or someone else's change) and the entry is dropped.
 */
export interface PendingEntry {
  props: Draft;
  seen: Draft[];
}

/** Per-node overlay for commits `baseDoc` has not confirmed yet. */
export type PendingProps = Map<string, PendingEntry>;

/** Most earlier versions one overlay entry remembers (the first is always kept). */
const MAX_SEEN_VERSIONS = 8;

/** Select value standing in for the `""` option, which Radix Select cannot hold. */
export const EMPTY_OPTION_VALUE = "\u0000empty";

const RESERVED_IDS = new Set(["__proto__", "constructor", "prototype"]);

/** An `id` safe to splice into the `/ui/<id>/value` state path. */
export function isValidStateId(id: unknown): id is string {
  return typeof id === "string" && /^[A-Za-z0-9_-]+$/.test(id) && !RESERVED_IDS.has(id);
}

export type FormMode =
  | { kind: "flat" }
  | { kind: "merge"; doc: Doc; nodeKey: string }
  | { kind: "too-large" };

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Keys that would reach the prototype if used as a plain-object key. */
function isUnsafeKey(key: string): boolean {
  return key === "__proto__";
}

/** Coerce `schema` into the capped list of controls (untrusted / mid-edit). */
export function deriveControls(schema: unknown): FormControls {
  if (!isPlainObject(schema) || !isPlainObject(schema.properties)) {
    return { controls: [], truncated: false };
  }
  const controls: FormControl[] = [];
  let truncated = false;
  for (const key of Object.keys(schema.properties)) {
    if (isUnsafeKey(key)) continue;
    if (controls.length >= SCHEMA_FORM_MAX_PROPERTIES) {
      truncated = true;
      break;
    }
    const raw = schema.properties[key];
    const prop = isPlainObject(raw) ? raw : {};
    const options = enumOptions(prop.enum);
    const type = prop.type;
    let kind: ControlKind = "text";
    if (type === "boolean") kind = "switch";
    else if (options.length > 0) kind = "select";
    else if (type === "number" || type === "integer") kind = "number";
    controls.push({
      key,
      kind,
      options,
      integer: type === "integer",
      description: typeof prop.description === "string" ? prop.description : undefined,
      default: prop.default,
    });
  }
  return { controls, truncated };
}

/** The distinct string members of `enum`, capped. */
function enumOptions(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const options = new Set<string>();
  for (const value of values) {
    if (typeof value !== "string" || value === EMPTY_OPTION_VALUE) continue;
    options.add(value);
    if (options.size >= SCHEMA_FORM_MAX_ENUM_OPTIONS) break;
  }
  return [...options];
}

/** The Select value for a draft value: unset shows the placeholder, `""` is the empty option. */
export function toSelectValue(current: unknown): string {
  if (current === undefined || current === null) return "";
  return current === "" ? EMPTY_OPTION_VALUE : String(current);
}

export function fromSelectValue(value: string): string {
  return value === EMPTY_OPTION_VALUE ? "" : value;
}

/**
 * What a number control commits for the text it holds: `{ value }` (cleared
 * text is `undefined`), or `null` to ignore an in-progress or invalid edit
 * (`-`, `Infinity`, or a decimal on an `integer` property).
 */
export function parseControlNumber(
  raw: string,
  integer: boolean,
): { value: number | undefined } | null {
  const parsed = parseNumberInputValue(raw);
  if (parsed === undefined) return null;
  if (parsed === null) return { value: undefined };
  if (integer && !Number.isInteger(parsed)) return null;
  return { value: parsed };
}

/** Serializes async tasks; a failing task is reported and never blocks the next. */
export function createCommitQueue(onError: (error: unknown) => void) {
  let tail: Promise<void> = Promise.resolve();
  return (task: () => Promise<void>): Promise<void> => {
    const run = tail.then(task).catch((error) => {
      onError(error);
    });
    tail = run;
    return run;
  };
}

/** Seed the draft: `seed[key] ?? default` for each control (own keys only). */
export function buildDraft(controls: readonly FormControl[], seed: unknown): Draft {
  const source = isPlainObject(seed) ? seed : {};
  const draft: Draft = {};
  for (const control of controls) {
    draft[control.key] = Object.hasOwn(source, control.key) ? source[control.key] : control.default;
  }
  return draft;
}

/**
 * Doc-merge mode needs a doc, a string `nodeKey` that is an OWN key of
 * `elements` (`Object.hasOwn`, so "constructor" / "__proto__" never match
 * inherited keys), and a doc small enough to merge. Anything else is flat mode.
 */
export function resolveMode(baseDoc: unknown, nodeKey: unknown): FormMode {
  if (!isPlainObject(baseDoc) || !isPlainObject(baseDoc.elements)) return { kind: "flat" };
  if (typeof nodeKey !== "string" || isUnsafeKey(nodeKey)) return { kind: "flat" };
  if (!Object.hasOwn(baseDoc.elements, nodeKey)) return { kind: "flat" };
  if (Object.keys(baseDoc.elements).length > SCHEMA_FORM_MAX_DOC_ELEMENTS) {
    return { kind: "too-large" };
  }
  return { kind: "merge", doc: baseDoc as unknown as Doc, nodeKey };
}

/** The props of `doc.elements[key]` when it is an own plain-object element. */
function elementProps(doc: Doc, key: string): Draft | null {
  if (!Object.hasOwn(doc.elements, key)) return null;
  const element = doc.elements[key];
  if (!isPlainObject(element) || !isPlainObject(element.props)) return null;
  return element.props;
}

/** What the draft seeds from in merge mode: the unconfirmed overlay, else the doc's props. */
export function mergeSeed(mode: Extract<FormMode, { kind: "merge" }>, pending: PendingProps) {
  return pending.get(mode.nodeKey)?.props ?? elementProps(mode.doc, mode.nodeKey) ?? undefined;
}

/**
 * Drop every overlay entry that is no longer outstanding: the doc caught up
 * with it, no longer has the node, or shows props the edit never passed
 * through (a different document, or a change made elsewhere).
 */
export function dropConfirmed(pending: PendingProps, doc: Doc): void {
  for (const [key, entry] of pending) {
    const shown = elementProps(doc, key);
    if (
      shown === null ||
      valuesEqual(shown, entry.props) ||
      !entry.seen.some((version) => valuesEqual(shown, version))
    ) {
      pending.delete(key);
    }
  }
}

/**
 * `doc` with every overlay entry applied on top. Structural sharing, no deep
 * clone: only `elements` and the overlaid elements are new objects, so the cost
 * is one pass over at most `SCHEMA_FORM_MAX_DOC_ELEMENTS` keys. Overlay keys
 * the doc no longer has are skipped.
 */
export function applyPending(doc: Doc, pending: PendingProps): Doc {
  if (pending.size === 0) return doc;
  const elements: Record<string, unknown> = { ...doc.elements };
  for (const [key, { props }] of pending) {
    if (isUnsafeKey(key) || !Object.hasOwn(doc.elements, key)) continue;
    const element = doc.elements[key];
    if (!isPlainObject(element)) continue;
    // defineProperty, not assignment: never a prototype write.
    Object.defineProperty(elements, key, {
      value: { ...element, props },
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return { ...doc, elements };
}

/**
 * The value mirrored to `/ui/<id>/value` for a commit of `draft`. Flat mode:
 * the draft. Merge mode: records the node's new props in `pending` (existing
 * props the schema does not list are kept, the draft wins on the rest) and
 * returns the whole doc with every outstanding overlay applied, so a later
 * commit on a different node cannot revert this one before the row catches up.
 */
export function commitValue(mode: FormMode, pending: PendingProps, draft: Draft): unknown {
  if (mode.kind !== "merge") return draft;
  const entry = pending.get(mode.nodeKey);
  const shown = elementProps(mode.doc, mode.nodeKey) ?? {};
  const props: Draft = { ...(entry?.props ?? shown), ...draft };
  // A cleared field is `undefined`; JSON drops it, so the overlay must too.
  for (const key of Object.keys(props)) if (props[key] === undefined) delete props[key];
  const seen = entry ? [...entry.seen, entry.props] : [shown];
  if (seen.length > MAX_SEEN_VERSIONS) seen.splice(1, 1);
  pending.set(mode.nodeKey, { props, seen });
  return applyPending(mode.doc, pending);
}

/**
 * Compare two JSON-like values, giving up (false) past the depth / node budget.
 * False only means "not confirmed", so a pathological value just keeps its overlay.
 */
export function valuesEqual(a: unknown, b: unknown): boolean {
  const budget = { nodes: SCHEMA_FORM_MAX_VALUE_NODES };
  return equalWithin(a, b, 0, budget);
}

function equalWithin(a: unknown, b: unknown, depth: number, budget: { nodes: number }): boolean {
  if (Object.is(a, b)) return true;
  if (--budget.nodes < 0 || depth > SCHEMA_FORM_MAX_VALUE_DEPTH) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, index) => equalWithin(item, b[index], depth + 1, budget));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  // An `undefined` value counts as an absent key: JSON round-trips drop it.
  const keys = Object.keys(left).filter((key) => left[key] !== undefined);
  const rightKeys = Object.keys(right).filter((key) => right[key] !== undefined);
  if (keys.length !== rightKeys.length) return false;
  return keys.every(
    (key) => Object.hasOwn(right, key) && equalWithin(left[key], right[key], depth + 1, budget),
  );
}

/** `JSON.stringify` that never recurses past the depth / node budget (cut parts render as "…"). */
export function boundedStringify(value: unknown): string {
  const budget = { nodes: SCHEMA_FORM_MAX_VALUE_NODES };
  return stringifyWithin(value, 0, budget);
}

function stringifyWithin(value: unknown, depth: number, budget: { nodes: number }): string {
  if (--budget.nodes < 0 || depth > SCHEMA_FORM_MAX_VALUE_DEPTH) return '"…"';
  if (value === undefined) return "null";
  if (typeof value === "bigint") return JSON.stringify(String(value));
  if (typeof value !== "object" || value === null) return JSON.stringify(value) ?? "null";
  const parts: string[] = [];
  const asArray = Array.isArray(value);
  const keys = asArray ? null : Object.keys(value);
  const length = asArray ? value.length : (keys?.length ?? 0);
  for (let i = 0; i < length; i++) {
    if (budget.nodes < 0) {
      parts.push('"…"');
      break;
    }
    if (asArray) {
      parts.push(stringifyWithin(value[i], depth + 1, budget));
    } else {
      const key = keys![i]!;
      const child = stringifyWithin((value as Record<string, unknown>)[key], depth + 1, budget);
      parts.push(`${JSON.stringify(key)}:${child}`);
    }
  }
  if (asArray) return `[${parts.join(",")}]`;
  return `{${parts.join(",")}}`;
}

/**
 * Identity of the form's inputs: the draft re-seeds when it changes (a new
 * node selected, a new schema bound, a new seed). Built from the capped
 * controls and a bounded rendering of the seed, so a hostile schema or seed
 * cannot make rendering throw or hang.
 */
export function formSignature(
  controls: readonly FormControl[],
  seed: unknown,
  nodeKey: string | undefined,
): string {
  const shape = controls.map((control) => [
    control.key,
    control.kind,
    control.options,
    control.default,
  ]);
  return boundedStringify({ shape, seed: seed ?? null, nodeKey: nodeKey ?? null });
}
