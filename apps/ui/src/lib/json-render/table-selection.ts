/**
 * Row-selection model for the swarm-apps `Table` (`selectable` / `bulkActions`).
 *
 * Selection is plain client state: an array of row ids under
 * `/ui/<table id>/selected`. These helpers are pure so the rules (header
 * tri-state, shift-click range, pruning rows that left the data) are unit-
 * testable without AG Grid or a DOM.
 *
 * Ids are strings: `rowIdOf` stringifies the `rowId` field, so a numeric id
 * `7` is stored as `"7"`.
 */

import { OUTCOME_PARAM } from "./assemble";

export type CheckState = boolean | "indeterminate";

/** The selection slot's value as a clean, de-duplicated id list (junk dropped). */
export function selectionFromState(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" || typeof entry === "number") seen.add(String(entry));
  }
  return [...seen];
}

/** Checked when every visible row is selected, indeterminate when only some are. */
export function headerCheckState(visibleIds: readonly string[], selected: ReadonlySet<string>) {
  if (visibleIds.length === 0) return false;
  const picked = visibleIds.filter((id) => selected.has(id)).length;
  if (picked === 0) return false;
  return picked === visibleIds.length ? true : ("indeterminate" as const);
}

/** One row on or off, keeping the order ids were first selected in. */
export function setRowSelected(selected: readonly string[], id: string, checked: boolean) {
  const has = selected.includes(id);
  if (checked) return has ? [...selected] : [...selected, id];
  return has ? selected.filter((entry) => entry !== id) : [...selected];
}

/**
 * The header checkbox. All visible selected -> deselect the visible rows (rows
 * hidden by a search or filter keep their state); otherwise select every
 * visible row.
 */
export function toggleAllVisible(selected: readonly string[], visibleIds: readonly string[]) {
  const visible = new Set(visibleIds);
  const current = new Set(selected);
  const allOn = visibleIds.length > 0 && visibleIds.every((id) => current.has(id));
  if (allOn) return selected.filter((id) => !visible.has(id));
  return [...selected, ...visibleIds.filter((id) => !current.has(id))];
}

/**
 * Shift-click: every row between `anchorId` and `targetId` (inclusive, in the
 * order the grid displays them) takes `checked`. Without a usable anchor it
 * degrades to a single-row toggle.
 */
export function applyRange(
  selected: readonly string[],
  displayOrder: readonly string[],
  anchorId: string | null,
  targetId: string,
  checked: boolean,
) {
  const to = displayOrder.indexOf(targetId);
  const from = anchorId === null ? -1 : displayOrder.indexOf(anchorId);
  if (to === -1 || from === -1) return setRowSelected(selected, targetId, checked);
  const [start, end] = from <= to ? [from, to] : [to, from];
  const range = displayOrder.slice(start, end + 1);
  if (checked) {
    const current = new Set(selected);
    return [...selected, ...range.filter((id) => !current.has(id))];
  }
  const drop = new Set(range);
  return selected.filter((id) => !drop.has(id));
}

/** Drops ids whose row left the data (a poll, a sync, a delete). Same array when nothing dropped. */
export function pruneSelection(selected: readonly string[], presentIds: ReadonlySet<string>) {
  const kept = selected.filter((id) => presentIds.has(id));
  return kept.length === selected.length ? (selected as string[]) : kept;
}

/** Selected rows a search or filter currently hides. */
export function hiddenSelectedCount(selected: readonly string[], visibleIds: readonly string[]) {
  const visible = new Set(visibleIds);
  return selected.filter((id) => !visible.has(id)).length;
}

/** Same ids in the same order. */
export function sameSelection(a: readonly string[], b: readonly string[]) {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** Where an `app.action` step's status slot lives (`/refs/<app>/actions/` for a borrowed action). */
export function actionSlotPath(binding: {
  action: string;
  params?: Record<string, unknown>;
}): string | null {
  if (binding.action !== "app.action") return null;
  const name = binding.params?.name;
  if (typeof name !== "string" || name === "") return null;
  const app = binding.params?.$app;
  const root = typeof app === "string" && app !== "" ? `/refs/${app}/actions` : "/actions";
  return `${root}/${name}`;
}

/** What is left selected once a bulk action finished: the late picks, never the rows it acted on. */
export function dropActedIds(current: readonly string[], acted: readonly string[]) {
  const done = new Set(acted);
  return current.filter((id) => !done.has(id));
}

export type BulkBinding = { action: string; params?: Record<string, unknown> };

export type BulkOutcome = "ok" | "failed" | "cancelled";

export interface BulkChainDeps {
  chain: readonly BulkBinding[];
  /** Slot an `app.mutate` step reports its result to (see `OUTCOME_PARAM`). */
  outcomePath: string;
  /** Runs one step. `extra` is merged over the step's resolved params. */
  execute: (binding: BulkBinding, extra?: Record<string, unknown>) => Promise<void>;
  read: (path: string) => unknown;
  write: (path: string, value: unknown) => void;
  /** True once the table unmounted: stop waiting, leave the selection alone. */
  cancelled: () => boolean;
  sleep: (ms: number) => Promise<void>;
  pollMs?: number;
}

function slotStatus(slot: unknown): unknown {
  return typeof slot === "object" && slot !== null
    ? (slot as { status?: unknown }).status
    : undefined;
}

/**
 * Runs a bulk action's chain and says whether it truly succeeded.
 *
 * The app runtime's handlers swallow their own failures, so a resolved
 * `execute` proves nothing. Each step is checked where the runtime reports it:
 *
 * - `app.mutate` is dispatched with an outcome slot (`OUTCOME_PARAM`) the handler
 *   writes `ok` or `error` to; a missing slot (a renderer that does not report)
 *   counts as failed, never as success.
 * - `app.action` ends with its `/actions/<name>` slot. A task-backed action
 *   returns while the slot is still `running`; the chain waits for the task's
 *   terminal status, so a task that fails later still fails the chain.
 *
 * Any failure stops the chain: later steps must not run against a failed one.
 */
export async function runBulkChain(deps: BulkChainDeps): Promise<BulkOutcome> {
  const pollMs = deps.pollMs ?? 250;
  for (const binding of deps.chain) {
    if (deps.cancelled()) return "cancelled";
    const tracked = binding.action === "app.mutate";
    if (tracked) deps.write(deps.outcomePath, undefined);
    try {
      await deps.execute(binding, tracked ? { [OUTCOME_PARAM]: deps.outcomePath } : undefined);
    } catch {
      return "failed";
    }
    if (tracked && slotStatus(deps.read(deps.outcomePath)) !== "ok") return "failed";

    const slotPath = actionSlotPath(binding);
    if (slotPath === null) continue;
    let status = slotStatus(deps.read(slotPath));
    while (status === "running") {
      await deps.sleep(pollMs);
      if (deps.cancelled()) return "cancelled";
      status = slotStatus(deps.read(slotPath));
    }
    if (status === "error") return "failed";
  }
  return "ok";
}
