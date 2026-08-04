/**
 * Spec assembler — expands `ElementRef` nodes into a plain json-render spec.
 *
 * `@json-render` stays stock: by the time `<Renderer>` sees a spec, every
 * `ElementRef` has been replaced by a clone of the referenced element's node
 * tree and every `ElementSlot` by the consumer's children. The runtime catalog
 * therefore never has to know those two node types exist.
 *
 * What a clone gets rewritten to (see `REWRITE_COVERAGE` for the enumerated,
 * test-asserted table):
 *
 *   - **node ids** — prefixed `ref:<instanceKey>:` so two instances of one
 *     element never collide in the flat `elements` map;
 *   - **interaction ids** (`props.id` of `Form` / `SearchInput` / `Select` /
 *     `Tabs`, and every `/forms/<id>` + `/ui/<id>` path pointing at them) —
 *     rewritten to `instances/<instanceKey>/<origId>`, so instance 1's input
 *     and instance 2's input hold independent state. No `pages/<p>` segment:
 *     the same instanceKey on two pages of one app shares interaction state,
 *     deliberately consistent with the cross-page-warm global store;
 *   - **element props** — `{"$state": "/props/<p>"}` is substituted with the
 *     consumer-supplied value (a literal, or the consumer's own binding, or
 *     the declared default);
 *   - **bound data refs** — `/queries/…` and `/actions/…` inside an element
 *     borrowed from ANOTHER app become `/refs/<definingAppId>/queries|actions/…`,
 *     which is app-relative and therefore resolves through the consuming app's
 *     plain prefixing `StoreView` (there is no absolute escape hatch). The
 *     surface mirrors the defining app's query results into those slots.
 *     A same-app element is NOT rewritten — its `/queries/<q>` already is the
 *     consuming app's own slot;
 *   - **actions** — `app.mutate` / `app.refresh` / `app.action` steps inside a
 *     foreign bound instance get a `$app: "<definingAppId>"` param so the
 *     surface's handlers call the DEFINING app's routes; anywhere else an
 *     authored `$app` is DELETED, so app JSON can never aim a handler at an
 *     app of its choosing. This marker (rather
 *     than a node-id → app sidecar map) is what reaches the handlers because
 *     `@json-render`'s `ActionProvider` invokes handlers with the resolved
 *     params ONLY — the dispatching node's identity is not passed through.
 *     `AssembledPage.instances` still reports the mapping for the surface's
 *     data plumbing and for debugging.
 *
 * Failure is always local: an unresolvable app, a deleted/unexported element,
 * a cycle or an over-deep chain renders an inline `Alert` card in that node's
 * place (the float model means a defining app can break its consumers between
 * validations, incl. deliberately via `forceElementBreak`) — never a throw.
 *
 * PURE MODULE — no React, no `@/` aliases, no store imports, relative imports
 * only. The root bun test runner (`src/tests/apps-element-assembly.test.ts`)
 * imports it directly; `apps/ui` has no test runner of its own.
 */

// ─── Mirrored server constants ──────────────────────────────────────────────
// Source of truth: `src/apps/page-validator.ts` (`ELEMENT_KEYS`,
// `MAX_ELEMENT_REF_DEPTH`, `UI_STATE_COMPONENTS`, `CONDITION_KEYS`). Mirrored
// rather than imported: this module must stay free of server imports (the API
// server owns the DB and drags `bun:sqlite` in through `src/apps/definition`).
// Keep in sync — a key the server accepts but this list misses would silently
// render un-rewritten inside an element instance.

/** Every key a definition element node may carry. */
export const ELEMENT_KEYS = [
  "type",
  "props",
  "children",
  "on",
  "visible",
  "repeat",
  "watch",
] as const;

/** Matches `MAX_ELEMENT_REF_DEPTH` in `src/apps/page-validator.ts`. */
export const MAX_ELEMENT_REF_DEPTH = 5;

/** Components whose `props.id` roots `/ui/<id>/…` interaction state. */
const UI_STATE_COMPONENTS = new Set(["SearchInput", "Select", "Tabs"]);

/** Components whose `props.id` roots `/forms/<id>/…` interaction state. */
const FORM_COMPONENTS = new Set(["Form"]);

/** Condition keys `evaluateVisibility` understands (`@json-render/core`). */
const COMPARISON_KEYS = ["eq", "neq", "gt", "gte", "lt", "lte"] as const;
const CONDITION_KEYS = new Set<string>([...COMPARISON_KEYS, "not"]);

/**
 * Actions that address one app's HTTP routes and therefore have to be routed
 * to the DEFINING app when they run inside a borrowed bound element.
 * `app.navigate` is deliberately absent: exported bound elements may not use it
 * (server-rejected), and a same-app instance navigates the consuming app.
 * `swarm.sdk` / `swarm.call` are absent too — their params are a wire payload,
 * not a routing envelope.
 */
const APP_SCOPED_ACTIONS = new Set(["app.mutate", "app.refresh", "app.action"]);

/**
 * Reserved action param carrying the app an action must execute against.
 * Assembler-owned: only `rewriteActionStep` ever writes it, and it strips any
 * occurrence it did not put there.
 */
export const DEFINING_APP_PARAM = "$app";

// ─── Input shapes ───────────────────────────────────────────────────────────
// Structural, deliberately loose: `AppDetail` / `AppDefinition` from
// `@/api/types` satisfy these without this module importing an aliased path.

export interface ElementPropDefLike {
  kind?: string;
  required?: boolean;
  enum?: string[];
  default?: string | number | boolean;
}

export interface ElementDefLike {
  mode: "pure" | "bound";
  export?: boolean;
  props?: Record<string, ElementPropDefLike>;
  root: string;
  elements: Record<string, unknown>;
}

export interface PageLike {
  root: string;
  elements: Record<string, unknown>;
}

export interface DefinitionLike {
  pages?: Record<string, PageLike>;
  elements?: Record<string, ElementDefLike>;
}

export interface AppRecordLike {
  id: string;
  name?: string | null;
  definition: DefinitionLike;
}

// ─── Output shapes ──────────────────────────────────────────────────────────

export interface AssembledSpec {
  root: string;
  elements: Record<string, unknown>;
}

/** One expanded `ElementRef`, in expansion order. */
export interface AssembledInstance {
  /** Dot-joined key: nested instances append their ref node's id. */
  instanceKey: string;
  /** Node-id prefix every node of this instance carries. */
  idPrefix: string;
  /** App whose `elements` map the subtree came from. */
  definingAppId: string;
  elementName: string;
  mode: "pure" | "bound";
  /** `false` for a same-app instance — nothing is routed through `/refs`. */
  foreign: boolean;
}

export interface AssemblyIssue {
  /** Node id in the SOURCE tree that failed (page-level id for top refs). */
  path: string;
  message: string;
}

export interface AssembledPage {
  /** `null` when the page does not exist in the definition. */
  spec: AssembledSpec | null;
  instances: AssembledInstance[];
  /**
   * Foreign query slots actually referenced by the expanded page:
   * `appId → query names`. The surface runs exactly these against the defining
   * app and mirrors them into `/refs/<appId>/queries/<name>`.
   */
  boundQueries: Record<string, string[]>;
  /** Foreign apps this page needs (bound data and/or pure element markup). */
  definingAppIds: string[];
  /** Referenced apps that could not be resolved — each rendered as a card. */
  missingAppIds: string[];
  issues: AssemblyIssue[];
}

// ─── Rewrite coverage (enumerated against ELEMENT_KEYS) ─────────────────────

export type RewriteKind =
  | "none"
  | "node-ids"
  | "state-paths"
  | "interaction-ids"
  | "prop-substitution"
  | "action-app-binding";

export interface RewriteRule {
  /** Where the field lives: an `ELEMENT_KEYS` entry, or the tree's `root`. */
  field: (typeof ELEMENT_KEYS)[number] | "root";
  rewrites: RewriteKind[];
  note: string;
}

/**
 * Which rewrite each element field receives. Enumerated against
 * `ELEMENT_KEYS` (plus the tree-level `root`) so a new element key cannot be
 * added server-side without this table — and its test — failing.
 */
export const REWRITE_COVERAGE: RewriteRule[] = [
  { field: "type", rewrites: ["none"], note: "component name, copied verbatim" },
  {
    field: "props",
    rewrites: ["state-paths", "interaction-ids", "prop-substitution", "action-app-binding"],
    note: "deep walk: every $state/$bindState/$cond binding, absolute-path interpolations inside a $template string, `statePath`/`clearStatePath` strings, action chains nested in props (Form.onSubmit, Table.rowActions[].actions) — including their `formId` (an interaction id, namespaced like `props.id`) and their `$app` routing marker — and the interaction `props.id` of Form/SearchInput/Select/Tabs",
  },
  {
    field: "children",
    rewrites: ["node-ids"],
    note: "child id array is remapped to the instance-prefixed ids; an ElementSlot child is spliced out and replaced by the consumer's own children ids",
  },
  {
    field: "on",
    rewrites: ["state-paths", "prop-substitution", "action-app-binding"],
    note: "event → action chain; params deep-rewritten, app-scoped steps tagged with $app",
  },
  {
    field: "visible",
    rewrites: ["state-paths", "prop-substitution"],
    note: "conditions incl. $and/$or arrays and $cond expressions; a condition (comparison OR bare truthiness) whose head substitutes to a LITERAL folds to a boolean, except that a live $state right-hand side is kept dynamic by flipping the comparison",
  },
  {
    field: "repeat",
    rewrites: ["state-paths"],
    note: "`repeat.statePath` is a raw path string (not a $state binding); RepeatChildren derives its scope basePath as `<statePath>/<index>`, so rewriting statePath covers $item/$index/$bindItem too",
  },
  {
    field: "watch",
    rewrites: ["state-paths", "prop-substitution", "action-app-binding"],
    note: "same chains as `on`, PLUS its map KEYS — a watch config is keyed by the state path it observes (`ElementRenderer` reads `getByPath(state, key)`), so the keys are rewritten as state paths too",
  },
  {
    field: "root",
    rewrites: ["node-ids"],
    note: "the element's own root becomes the instance-prefixed id that replaces the ElementRef node in its parent's children",
  },
];

// ─── Small helpers ──────────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStateNode(value: unknown): value is Record<string, unknown> & { $state: string } {
  return isPlainObject(value) && typeof value.$state === "string";
}

function isConditionShaped(value: Record<string, unknown>): boolean {
  return Object.keys(value).some((key) => CONDITION_KEYS.has(key));
}

// ─── Assembly scope ─────────────────────────────────────────────────────────

interface Scope {
  /** `""` for the consumer page's own nodes. */
  idPrefix: string;
  /** `null` for the consumer page's own nodes. */
  instanceKey: string | null;
  /** App that owns the nodes being emitted in this scope. */
  definingAppId: string;
  /** `true` when `definingAppId` is not the consuming app. */
  foreign: boolean;
  mode: "page" | "pure" | "bound";
  /** Consumer-supplied prop values, already rewritten in the OUTER scope. */
  propValues: Record<string, unknown>;
  /** `props.id`s declared inside this element that root `/ui/<id>`. */
  uiIds: Set<string>;
  /** `props.id`s declared inside this element that root `/forms/<id>`. */
  formIds: Set<string>;
  /** Already-emitted consumer child ids spliced at this element's slot. */
  slotChildren: string[];
  depth: number;
  /** `<appId>\0<elementName>` chain guarding against reference cycles. */
  stack: readonly string[];
}

interface AssemblyState {
  consumerAppId: string;
  resolvedApps: Map<string, AppRecordLike>;
  /** Apps whose definition request is still in flight — not yet a failure. */
  pendingAppIds: Set<string>;
  out: Record<string, unknown>;
  instances: AssembledInstance[];
  boundQueries: Map<string, Set<string>>;
  definingAppIds: Set<string>;
  missingAppIds: Set<string>;
  issues: AssemblyIssue[];
}

// ─── Path rewriting ─────────────────────────────────────────────────────────

/**
 * App-relative state path → the path the same reference must use inside an
 * expanded instance. Identity for page-scope nodes.
 */
function rewriteStatePath(path: string, scope: Scope, state: AssemblyState): string {
  if (scope.mode === "page" || !path.startsWith("/")) return path;

  const match = /^\/(queries|actions|forms|ui)\/([^/]+)(\/.*)?$/.exec(path);
  if (!match) return path; // `/route/...` and anything unrecognised: consumer-relative.
  const namespace = match[1]!;
  const name = match[2]!;
  const rest = match[3] ?? "";

  if (namespace === "queries" || namespace === "actions") {
    // Same-app elements keep reading the consuming app's own slots; only a
    // BORROWED bound element is mirrored under `/refs/<definingAppId>`.
    if (!scope.foreign) return path;
    if (namespace === "queries") {
      const names = state.boundQueries.get(scope.definingAppId) ?? new Set<string>();
      names.add(name);
      state.boundQueries.set(scope.definingAppId, names);
    }
    return `/refs/${scope.definingAppId}/${namespace}/${name}${rest}`;
  }

  // Interaction state: only ids DECLARED inside this element are scoped — a
  // path aimed at anything else stays consumer-relative (the server rejects
  // that shape, so this is defensive).
  const declared = namespace === "ui" ? scope.uiIds : scope.formIds;
  if (!scope.instanceKey || !declared.has(name)) return path;
  return `/${namespace}/${instanceId(scope.instanceKey, name)}${rest}`;
}

/** The interaction id an element-local `origId` takes inside an instance. */
function instanceId(instanceKey: string, origId: string): string {
  return `instances/${instanceKey}/${origId}`;
}

/** `${/path}` refs inside a `$template` string. */
function rewriteTemplate(template: string, scope: Scope, state: AssemblyState): string {
  return template.replace(/\$\{([^}]+)\}/g, (match, rawPath: string) =>
    rawPath.startsWith("/") ? `\${${rewriteStatePath(rawPath, scope, state)}}` : match,
  );
}

// ─── Value rewriting ────────────────────────────────────────────────────────

/** Stands in for a comparison RHS that only resolves at render time. */
const LIVE_RHS = Symbol("live-rhs");

/**
 * Statically evaluate a condition whose `$state` head was substituted with a
 * LITERAL prop value. Mirrors `evaluateCondition` in `@json-render/core` —
 * a condition object needs a live binding head, so once the head is a constant
 * the only faithful expansion is the boolean it would have produced. A live
 * RHS that `invertComparison` could not flip folds against a sentinel: never
 * equal, never ordered — which is what the renderer produces for a comparison
 * it cannot resolve anyway.
 */
function evaluateStaticCondition(condition: Record<string, unknown>, value: unknown): boolean {
  const rhs = (raw: unknown): unknown => (isStateNode(raw) ? LIVE_RHS : raw);
  let result: boolean;
  if (condition.eq !== undefined) result = value === rhs(condition.eq);
  else if (condition.neq !== undefined) result = value !== rhs(condition.neq);
  else if (condition.gt !== undefined) result = compare(value, rhs(condition.gt), (a, b) => a > b);
  else if (condition.gte !== undefined)
    result = compare(value, rhs(condition.gte), (a, b) => a >= b);
  else if (condition.lt !== undefined) result = compare(value, rhs(condition.lt), (a, b) => a < b);
  else if (condition.lte !== undefined)
    result = compare(value, rhs(condition.lte), (a, b) => a <= b);
  else result = Boolean(value);
  return condition.not === true ? !result : result;
}

function compare(left: unknown, right: unknown, op: (a: number, b: number) => boolean): boolean {
  return typeof left === "number" && typeof right === "number" ? op(left, right) : false;
}

/** `/props/<name><suffix>` → the consumer's value, suffix applied. */
function applyPropSuffix(supplied: unknown, suffix: string): unknown {
  if (suffix === "") return supplied;
  // A deeper read only survives on a state binding (paths concatenate). Prop
  // values are scalars, so a suffix on a literal has nothing to address.
  if (isPlainObject(supplied) && typeof supplied.$state === "string") {
    return { ...supplied, $state: `${supplied.$state}${suffix}` };
  }
  return undefined;
}

/** `a <op> b` → `b <flipped op> a`, for the comparators the renderer has. */
const FLIPPED_COMPARATOR: Record<(typeof COMPARISON_KEYS)[number], string> = {
  eq: "eq",
  neq: "neq",
  gt: "lt",
  gte: "lte",
  lt: "gt",
  lte: "gte",
};

/**
 * Literal LHS + LIVE RHS: keep the comparison dynamic by swapping the sides.
 *
 * `{$state:"/props/min", lt:{$state:"/queries/q/data/0/n"}}` with `min` supplied
 * as `5` becomes `{$state:"/queries/q/data/0/n", gt:5}` — same truth value, and
 * still re-evaluated whenever the query slot changes. Folding it to a constant
 * instead (the naive path) would freeze the condition at assembly time.
 *
 * Only a `$state` RHS is invertible: `resolveComparisonValue` in
 * `@json-render/core` resolves nothing else, so an `$item`/`$index`/literal-
 * object RHS is compared raw and the static fold already matches the renderer.
 * An `undefined` literal (unsupplied optional prop) is not inverted either —
 * `eq: undefined` would silently degrade to a truthiness test.
 */
function invertComparison(
  others: Record<string, unknown>,
  literal: unknown,
): Record<string, unknown> | null {
  if (literal === undefined) return null;
  for (const key of COMPARISON_KEYS) {
    if (others[key] === undefined) continue;
    const rhs = others[key];
    if (!isStateNode(rhs)) return null;
    const flipped: Record<string, unknown> = {
      $state: rhs.$state,
      [FLIPPED_COMPARATOR[key]]: literal,
    };
    if (others.not === true) flipped.not = true;
    return flipped;
  }
  return null;
}

/** The binding keys that can head a condition object, taken from a value. */
function conditionHead(supplied: unknown): Record<string, unknown> | null {
  if (!isPlainObject(supplied)) return null;
  if (typeof supplied.$state === "string") return { $state: supplied.$state };
  if (typeof supplied.$item === "string") return { $item: supplied.$item };
  if (supplied.$index === true) return { $index: true };
  if (typeof supplied.$bindState === "string") return { $state: supplied.$bindState };
  return null;
}

/**
 * A value in CONDITION position — `visible`, a `$cond` test, or a member of a
 * `$and` / `$or` array. Tracked separately from ordinary values because a
 * substituted prop must fold to a BOOLEAN here: `evaluateCondition` does
 * `"$and" in condition` on whatever it is handed, which throws a TypeError on
 * a bare string/number (verified) — so leaving a raw literal in a `visible`
 * slot white-screens the page.
 */
function rewriteCondition(value: unknown, scope: Scope, state: AssemblyState): unknown {
  if (typeof value === "boolean") return value;
  // An array of conditions is an implicit AND (`evaluateVisibility`).
  if (Array.isArray(value)) return value.map((entry) => rewriteCondition(entry, scope, state));
  if (!isPlainObject(value)) return value;
  for (const logical of ["$and", "$or"] as const) {
    if (!Object.hasOwn(value, logical)) continue;
    const children = value[logical];
    return {
      ...value,
      [logical]: Array.isArray(children)
        ? children.map((child) => rewriteCondition(child, scope, state))
        : rewriteCondition(children, scope, state),
    };
  }
  if (isStateNode(value)) return rewriteStateNode(value, scope, state, true);
  return rewriteValue(value, scope, state);
}

function rewriteValue(value: unknown, scope: Scope, state: AssemblyState): unknown {
  if (Array.isArray(value)) return value.map((entry) => rewriteValue(entry, scope, state));
  if (!isPlainObject(value)) return value;

  if (isStateNode(value)) return rewriteStateNode(value, scope, state, false);

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if ((key === "statePath" || key === "clearStatePath") && typeof child === "string") {
      out[key] = rewriteStatePath(child, scope, state);
    } else if (key === "$bindState" && typeof child === "string") {
      out[key] = rewriteStatePath(child, scope, state);
    } else if (key === "$template" && typeof child === "string") {
      out[key] = rewriteTemplate(child, scope, state);
    } else if (key === "$cond") {
      // `{ $cond, $then, $else }` — the test is a visibility condition.
      out[key] = rewriteCondition(child, scope, state);
    } else {
      out[key] = rewriteValue(child, scope, state);
    }
  }

  if (typeof out.action === "string") rewriteActionStep(out, scope);
  return out;
}

/**
 * Normalize one action step's params, in place.
 *
 * `$app` is set UNCONDITIONALLY: injected (overwriting anything authored) for
 * an app-scoped action inside a borrowed instance, and DELETED everywhere
 * else. The marker is a private channel between this assembler and the
 * surface's handlers, so app JSON must never be able to plant one and route
 * `app.mutate` / `app.action` at an arbitrary app — the handlers trust it.
 * The surface reads it but does not remove it; deletion happens here.
 *
 * `formId` (the form an `app.mutate` create clears afterwards) is an
 * interaction id like `props.id`, so it takes the same instance namespacing.
 */
function rewriteActionStep(step: Record<string, unknown>, scope: Scope): void {
  const action = step.action as string;
  const params = isPlainObject(step.params) ? { ...step.params } : undefined;
  const inject = scope.foreign && APP_SCOPED_ACTIONS.has(action);

  if (inject) {
    const next = params ?? {};
    next[DEFINING_APP_PARAM] = scope.definingAppId;
    step.params = next;
  } else if (params && DEFINING_APP_PARAM in params) {
    delete params[DEFINING_APP_PARAM];
    step.params = params;
  }

  if (action !== "app.mutate" || !scope.instanceKey) return;
  const current = isPlainObject(step.params) ? step.params : undefined;
  const formId = current?.formId;
  if (typeof formId !== "string" || !scope.formIds.has(formId)) return;
  step.params = { ...current, formId: instanceId(scope.instanceKey, formId) };
}

function rewriteStateNode(
  node: Record<string, unknown> & { $state: string },
  scope: Scope,
  state: AssemblyState,
  conditionPosition: boolean,
): unknown {
  const others: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(node)) {
    if (key === "$state") continue;
    others[key] = rewriteValue(child, scope, state);
  }
  // Comparison keys make it a condition wherever it sits; `visible` and
  // `$cond` make even the bare truthiness form one.
  const condition = isConditionShaped(node) || conditionPosition;

  const propMatch = /^\/props\/([^/]+)(\/.*)?$/.exec(node.$state);
  if (propMatch && scope.mode !== "page") {
    const substituted = applyPropSuffix(scope.propValues[propMatch[1]!], propMatch[2] ?? "");
    if (!condition) {
      // Plain binding: the consumer's literal / binding takes its place
      // wholesale (extra keys on a non-condition $state node are meaningless
      // to the renderer, so they are dropped with it).
      return substituted;
    }
    const head = conditionHead(substituted);
    if (head) return { ...others, ...head };
    // Literal (or unsupplied → `undefined`, which folds to `false`, matching
    // what `getByPath` on the unexpanded path would have yielded).
    return invertComparison(others, substituted) ?? evaluateStaticCondition(others, substituted);
  }

  return { ...others, $state: rewriteStatePath(node.$state, scope, state) };
}

// ─── Node emission ──────────────────────────────────────────────────────────

function card(tone: "error" | "info", title: string, message: string): Record<string, unknown> {
  return { type: "Alert", props: { tone, title, message } };
}

/** Interaction ids declared inside one element's node map. */
function collectInteractionIds(elements: Record<string, unknown>): {
  uiIds: Set<string>;
  formIds: Set<string>;
} {
  const uiIds = new Set<string>();
  const formIds = new Set<string>();
  for (const node of Object.values(elements)) {
    if (!isPlainObject(node) || typeof node.type !== "string") continue;
    const props = isPlainObject(node.props) ? node.props : undefined;
    const id = props && typeof props.id === "string" ? props.id : undefined;
    if (!id) continue;
    if (UI_STATE_COMPONENTS.has(node.type)) uiIds.add(id);
    else if (FORM_COMPONENTS.has(node.type)) formIds.add(id);
  }
  return { uiIds, formIds };
}

interface EmitContext {
  /** Source node map the ids in this scope resolve against. */
  elements: Record<string, unknown>;
  scope: Scope;
  /** Guards a malformed (cyclic) child graph; validation forbids one. */
  visiting: Set<string>;
}

/**
 * Emit one source node (and its subtree) into `state.out`.
 * Returns the emitted id, or `null` when the node does not exist.
 */
function emitNode(sourceId: string, ctx: EmitContext, state: AssemblyState): string | null {
  const raw = Object.hasOwn(ctx.elements, sourceId) ? ctx.elements[sourceId] : undefined;
  if (!isPlainObject(raw)) return null;
  const emittedId = `${ctx.scope.idPrefix}${sourceId}`;
  if (ctx.visiting.has(sourceId)) return null; // cycle in `children` — drop the back edge.

  if (raw.type === "ElementRef") {
    return expandRef(sourceId, emittedId, raw, ctx, state);
  }

  ctx.visiting.add(sourceId);
  const node: Record<string, unknown> = { type: raw.type };

  // `props` is normalized to `{}`: the bundled renderer's `resolveBindings`
  // calls `Object.entries(props)` without a null guard, so one propless
  // container (a shape the validator accepts) would crash the whole page.
  const rawProps = isPlainObject(raw.props) ? raw.props : {};
  const props = rewriteValue(rawProps, ctx.scope, state) as Record<string, unknown>;
  if (
    ctx.scope.instanceKey &&
    typeof raw.type === "string" &&
    (UI_STATE_COMPONENTS.has(raw.type) || FORM_COMPONENTS.has(raw.type)) &&
    typeof rawProps.id === "string"
  ) {
    props.id = instanceId(ctx.scope.instanceKey, rawProps.id);
  }
  node.props = props;

  if (Array.isArray(raw.children)) {
    node.children = emitChildren(raw.children, ctx, state);
  }
  for (const key of ["on", "repeat"] as const) {
    if (!Object.hasOwn(raw, key)) continue;
    node[key] = rewriteValue(raw[key], ctx.scope, state);
  }
  // `visible` is a condition position: a substituted literal MUST fold to a
  // boolean here (see `rewriteCondition`).
  if (Object.hasOwn(raw, "visible")) {
    node.visible = rewriteCondition(raw.visible, ctx.scope, state);
  }
  // `watch` is keyed BY the observed state path, not by an event name.
  if (Object.hasOwn(raw, "watch")) {
    node.watch = isPlainObject(raw.watch)
      ? Object.fromEntries(
          Object.entries(raw.watch).map(([path, chain]) => [
            rewriteStatePath(path, ctx.scope, state),
            rewriteValue(chain, ctx.scope, state),
          ]),
        )
      : rewriteValue(raw.watch, ctx.scope, state);
  }

  ctx.visiting.delete(sourceId);
  state.out[emittedId] = node;
  return emittedId;
}

/** Child id array → emitted ids, with `ElementSlot` children spliced out. */
function emitChildren(children: unknown[], ctx: EmitContext, state: AssemblyState): string[] {
  const emitted: string[] = [];
  for (const child of children) {
    if (typeof child !== "string") continue;
    const raw = Object.hasOwn(ctx.elements, child) ? ctx.elements[child] : undefined;
    if (isPlainObject(raw) && raw.type === "ElementSlot") {
      emitted.push(...ctx.scope.slotChildren);
      continue;
    }
    const id = emitNode(child, ctx, state);
    if (id) emitted.push(id);
  }
  return emitted;
}

function expandRef(
  sourceId: string,
  emittedId: string,
  raw: Record<string, unknown>,
  ctx: EmitContext,
  state: AssemblyState,
): string {
  const fail = (message: string): string => {
    state.issues.push({ path: sourceId, message });
    state.out[emittedId] = card("error", "Element unavailable", message);
    return emittedId;
  };

  const refProps = isPlainObject(raw.props) ? raw.props : {};
  const elementName = refProps.element;
  if (typeof elementName !== "string") {
    return fail("ElementRef is missing a literal `element` name.");
  }
  if (refProps.app !== undefined && typeof refProps.app !== "string") {
    return fail(`ElementRef "${elementName}" has a non-literal \`app\`.`);
  }
  const definingAppId = (refProps.app as string | undefined) ?? ctx.scope.definingAppId;

  if (ctx.scope.depth + 1 > MAX_ELEMENT_REF_DEPTH) {
    return fail(
      `Element "${elementName}" nests deeper than the maximum reference depth of ${MAX_ELEMENT_REF_DEPTH}.`,
    );
  }
  const stackKey = `${definingAppId}\0${elementName}`;
  if (ctx.scope.stack.includes(stackKey)) {
    return fail(`Element "${elementName}" references itself (reference cycle).`);
  }

  const foreign = definingAppId !== state.consumerAppId;
  if (foreign) state.definingAppIds.add(definingAppId);
  const targetApp = foreign
    ? state.resolvedApps.get(definingAppId)
    : state.resolvedApps.get(state.consumerAppId);
  if (!targetApp) {
    // Still fetching is not a failure: a neutral placeholder holds the spot
    // for the render or two before the definition lands.
    if (state.pendingAppIds.has(definingAppId)) {
      state.out[emittedId] = card("info", "Loading…", `Loading "${elementName}".`);
      return emittedId;
    }
    state.missingAppIds.add(definingAppId);
    return fail(`App "${definingAppId}" is not available, so "${elementName}" cannot render.`);
  }

  const target = targetApp.definition.elements?.[elementName];
  if (!target || !isPlainObject(target.elements)) {
    const where = foreign ? ` in app "${targetApp.name ?? definingAppId}"` : " in this app";
    return fail(`Element "${elementName}" was not found${where}.`);
  }
  if (foreign && target.export !== true) {
    return fail(
      `Element "${elementName}" is not exported by app "${targetApp.name ?? definingAppId}".`,
    );
  }

  // instanceKey: explicit prop, else the referencing node's id; nested
  // instances qualify with their parent's key so two instances of an element
  // that itself contains a ref stay disjoint.
  const localKey =
    typeof refProps.instanceKey === "string" && refProps.instanceKey
      ? refProps.instanceKey
      : sourceId;
  const instanceKey = ctx.scope.instanceKey ? `${ctx.scope.instanceKey}.${localKey}` : localKey;

  // Consumer children are emitted in the CONSUMER's scope (their bindings are
  // consumer-relative) and spliced at the target's ElementSlot.
  const slotChildren = Array.isArray(raw.children) ? emitChildren(raw.children, ctx, state) : [];

  // Prop values: consumer-supplied (rewritten in the consumer's scope) or the
  // declared default.
  const supplied = isPlainObject(refProps.props) ? refProps.props : {};
  const propValues: Record<string, unknown> = {};
  for (const [name, declared] of Object.entries(target.props ?? {})) {
    propValues[name] = Object.hasOwn(supplied, name)
      ? rewriteValue(supplied[name], ctx.scope, state)
      : declared?.default;
  }
  // Undeclared extras are still substitutable (the server rejects them, so
  // this only matters for a definition that drifted).
  for (const [name, value] of Object.entries(supplied)) {
    if (!Object.hasOwn(propValues, name)) propValues[name] = rewriteValue(value, ctx.scope, state);
  }

  const { uiIds, formIds } = collectInteractionIds(target.elements);
  const mode: "pure" | "bound" = target.mode === "pure" ? "pure" : "bound";
  const scope: Scope = {
    idPrefix: `ref:${instanceKey}:`,
    instanceKey,
    definingAppId,
    foreign,
    mode,
    propValues,
    uiIds,
    formIds,
    slotChildren,
    depth: ctx.scope.depth + 1,
    stack: [...ctx.scope.stack, stackKey],
  };

  state.instances.push({
    instanceKey,
    idPrefix: scope.idPrefix,
    definingAppId,
    elementName,
    mode,
    foreign,
  });

  const rootNode = Object.hasOwn(target.elements, target.root)
    ? target.elements[target.root]
    : undefined;
  if (isPlainObject(rootNode) && rootNode.type === "ElementSlot") {
    // Degenerate shape: the whole element IS the slot. One child can stand in
    // for it; zero or many have no single node to become.
    if (slotChildren.length === 1) return slotChildren[0]!;
    return fail(`Element "${elementName}" is a bare ElementSlot and needs exactly one child.`);
  }

  const emitted = emitNode(
    target.root,
    { elements: target.elements, scope, visiting: new Set() },
    state,
  );
  if (!emitted) {
    return fail(`Element "${elementName}" has no root node "${target.root}".`);
  }
  return emitted;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Expand `pageName` of `app` into a spec `<Renderer>` can consume directly.
 *
 * `resolvedApps` supplies every app whose elements are referenced (the
 * consuming app included — pass it in the map, or it is added automatically).
 * A target that is gone (deleted app, deleted or un-exported element) yields an
 * inline error card in that node's place, never a throw; an app listed in
 * `options.pendingAppIds` is still being fetched and gets a neutral loading
 * card instead, so a first paint never accuses a healthy reference.
 */
export function assemblePageSpec(
  app: AppRecordLike,
  pageName: string,
  resolvedApps: Map<string, AppRecordLike>,
  options: { pendingAppIds?: Iterable<string> } = {},
): AssembledPage {
  const page = app.definition.pages?.[pageName];
  const apps = new Map(resolvedApps);
  apps.set(app.id, app);

  const state: AssemblyState = {
    consumerAppId: app.id,
    resolvedApps: apps,
    pendingAppIds: new Set(options.pendingAppIds ?? []),
    out: {},
    instances: [],
    boundQueries: new Map(),
    definingAppIds: new Set(),
    missingAppIds: new Set(),
    issues: [],
  };

  const result = (spec: AssembledSpec | null): AssembledPage => ({
    spec,
    instances: state.instances,
    boundQueries: Object.fromEntries(
      [...state.boundQueries].map(([appId, names]) => [appId, [...names]]),
    ),
    definingAppIds: [...state.definingAppIds],
    missingAppIds: [...state.missingAppIds],
    issues: state.issues,
  });

  if (!page || !isPlainObject(page.elements) || typeof page.root !== "string") return result(null);

  const scope: Scope = {
    idPrefix: "",
    instanceKey: null,
    definingAppId: app.id,
    foreign: false,
    mode: "page",
    propValues: {},
    uiIds: new Set(),
    formIds: new Set(),
    slotChildren: [],
    depth: 0,
    stack: [],
  };
  const root = emitNode(page.root, { elements: page.elements, scope, visiting: new Set() }, state);
  if (!root) return result(null);
  return result({ root, elements: state.out });
}

/**
 * Every FOREIGN app id the definition's `ElementRef`s reach, following refs
 * into already-resolved apps (depth-capped like the expander). The surface
 * feeds this to its single `useQueries` over app definitions; each newly
 * resolved app can reveal one more level, which converges within
 * `MAX_ELEMENT_REF_DEPTH` renders.
 */
export function collectElementRefAppIds(
  app: AppRecordLike,
  resolvedApps: Map<string, AppRecordLike> = new Map(),
): string[] {
  const found = new Set<string>();
  const seen = new Set<string>();

  const walkTree = (elements: Record<string, unknown>, ownerAppId: string, depth: number): void => {
    if (depth > MAX_ELEMENT_REF_DEPTH) return;
    for (const node of Object.values(elements)) {
      if (!isPlainObject(node) || node.type !== "ElementRef") continue;
      const props = isPlainObject(node.props) ? node.props : {};
      if (typeof props.element !== "string") continue;
      const targetAppId = typeof props.app === "string" ? props.app : ownerAppId;
      if (targetAppId !== app.id) found.add(targetAppId);

      const key = `${targetAppId}\0${props.element}\0${depth}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const targetApp = targetAppId === app.id ? app : resolvedApps.get(targetAppId);
      const target = targetApp?.definition.elements?.[props.element];
      if (target && isPlainObject(target.elements)) {
        walkTree(target.elements, targetAppId, depth + 1);
      }
    }
  };

  for (const page of Object.values(app.definition.pages ?? {})) {
    if (isPlainObject(page?.elements)) walkTree(page.elements, app.id, 1);
  }
  for (const element of Object.values(app.definition.elements ?? {})) {
    if (isPlainObject(element?.elements)) walkTree(element.elements, app.id, 1);
  }
  return [...found];
}
