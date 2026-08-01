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
 *   - `{ $state: "/path" }`                 — json-render state read
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
  /** Live json-render state snapshot, for `$state` reads. */
  state?: Record<string, unknown>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
  if ("$state" in value && typeof value.$state === "string") {
    return getByPath(scope.state ?? {}, value.$state);
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = resolveScopedValue(entry, scope);
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
