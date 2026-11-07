/**
 * Scoped action-param resolution for the `Table` / `Form` catalog components.
 *
 * Why the custom `$row` / `$form` sentinels instead of json-render's `$item`:
 *
 *   - `Table` and `Form` carry their action chains inside **props**
 *     (`rowActions[].actions[].params`, `onSubmit[].params`), and the renderer
 *     runs `resolveElementProps` → `resolvePropValue` **recursively** over
 *     every prop before the component is called. A `{ $item: "id" }` written
 *     there is therefore resolved eagerly, outside any `RepeatScopeProvider`,
 *     and collapses to `undefined` before `Table` can bind it to a row.
 *     `$row` / `$rowIndex` / `$form` are not json-render expressions, so they
 *     survive prop resolution untouched and Table/Form can resolve them
 *     per row / on submit.
 *   - json-render's own `resolveActionParam` also only walks the TOP level of
 *     `params`, while `app.mutate` nests the interesting expressions one level
 *     down in `params.values`.
 *
 * So Table/Form resolve their own chains against an explicit scope and hand
 * `ActionProvider.execute` a binding whose params are already plain values
 * (`resolveAction` passes non-`$state` values straight through).
 *
 * Supported expressions (recursively, inside objects and arrays):
 *   - `{ $row: "col" }` / `{ $row: "" }`    — row field / whole row
 *   - `{ $rowIndex: true }`                 — row index
 *   - `{ $form: "field" }` / `{ $form: "" }`— form field / all collected values
 *   - `{ $value: true }`                    — the committed value of a component that mirrors
 *     one to `/ui/<id>/value` (SchemaForm). Needed because a `{ $state: "/ui/<id>/value" }`
 *     in the chain is resolved by the renderer BEFORE the commit, so it carries the
 *     previous value.
 *   - `{ $state: "/path" }`                 — json-render state read
 *   - `{ $chain: "key" }` / `{ $chain: "" }`— chain-derived value (e.g. `leafTaskId` /
 *     `newTaskId` set by a component that runs a task chain, or Approval's `status` /
 *     `responses` / `resolvedBy`) / whole chain object.
 *     Explicit absence: a chain-running component publishes every key it knows,
 *     `null` when there is no value yet. A key that is present and `null` (or
 *     `undefined`) resolves to `undefined`, and an object entry holding it is
 *     dropped (no `parentTaskId` → a root task). An unresolvable `$chain` (no
 *     chain scope at all, or a key the scope does not carry) is returned as-is.
 * Anything else is a literal.
 */

import { getByPath } from "@json-render/core";

export interface ParamScope {
  /** The current row (Table row actions) — target of `$row`. */
  row?: Record<string, unknown>;
  /** The current row index (Table row actions) — target of `$rowIndex`. */
  rowIndex?: number;
  /** Collected form values (Form submit). */
  form?: Record<string, unknown>;
  /** The value a component just committed (SchemaForm) — target of `$value`. */
  value?: unknown;
  /** Live json-render state snapshot, for `$state` reads. */
  state?: Record<string, unknown>;
  /**
   * Chain-derived values published by the component that runs the chain:
   * a task chain's current leaf / newly created task id, or Approval's
   * `{ status, responses, resolvedBy }` — target of `$chain`. Table/Form
   * dispatch scopes leave it unset, and a `$chain` they cannot resolve stays a
   * sentinel. A key that is present with `null` means "no value yet" and
   * resolves to `undefined` (see `resolveScopedValue`).
   */
  chain?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChainBinding(value: unknown): value is { $chain: string } {
  return isPlainObject(value) && "$chain" in value && typeof value.$chain === "string";
}

export function resolveScopedValue(value: unknown, scope: ParamScope): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => resolveScopedValue(entry, scope));
  }
  if (!isPlainObject(value)) return value;

  if ("$row" in value && typeof value.$row === "string") {
    if (scope.row === undefined) return undefined;
    return value.$row === "" ? scope.row : getByPath(scope.row, value.$row);
  }
  if ("$rowIndex" in value && value.$rowIndex === true) {
    return scope.rowIndex;
  }
  if ("$form" in value && typeof value.$form === "string") {
    if (scope.form === undefined) return undefined;
    return value.$form === "" ? scope.form : getByPath(scope.form, value.$form);
  }
  if ("$value" in value && value.$value === true) {
    return scope.value;
  }
  if ("$state" in value && typeof value.$state === "string") {
    return getByPath(scope.state ?? {}, value.$state);
  }
  if (isChainBinding(value)) {
    // An unresolvable `$chain` is kept as the sentinel object, not collapsed to
    // `undefined` like a missing `$row` field: a `parentTaskId` that quietly
    // disappears changes task topology (a root task instead of a chained one).
    // Leaving it visible lets the `app.action` handler reject the dispatch.
    // Only a key the chain scope publishes as `null` is an intentional absence.
    if (scope.chain === undefined) return value;
    if (value.$chain === "") return scope.chain;
    const chain: Record<string, unknown> = scope.chain;
    if (Object.hasOwn(chain, value.$chain)) return chain[value.$chain] ?? undefined;
    // A nested path under a published key (Approval's `responses/<questionId>`)
    // reads into it; a missing leaf keeps the sentinel like a missing key.
    const head = value.$chain.replace(/^\//, "").split("/")[0] ?? "";
    if (!value.$chain.includes("/") || !Object.hasOwn(chain, head)) return value;
    const nested = getByPath(chain, value.$chain);
    return nested === undefined ? value : nested;
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    const resolved = resolveScopedValue(entry, scope);
    // Explicit `$chain` absence drops the key outright, so the dispatched
    // params carry no `parentTaskId` at all (not one set to `undefined`).
    if (resolved === undefined && isChainBinding(entry)) continue;
    out[key] = resolved;
  }
  return out;
}

export function resolveScopedParams(
  params: Record<string, unknown> | undefined,
  scope: ParamScope,
): Record<string, unknown> {
  if (!params) return {};
  return resolveScopedValue(params, scope) as Record<string, unknown>;
}
