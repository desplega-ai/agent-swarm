import { useCallback, useLayoutEffect, useSyncExternalStore } from "react";

/**
 * Which step blocks of a session are open (SPEC R8.3: "remember the state per
 * turn"). It lives for the page session, per root, outside the components, so
 * a pane that remounts (tabs, a split) keeps it.
 *
 * Handoffs Off: a block is open when a person opened it. Handoffs On: every
 * block is open, except the ones a person closed during this On period. Any
 * change of Handoffs forgets those closes.
 */
export interface StepBlocks {
  opened: ReadonlySet<string>;
  /** Blocks closed while Handoffs was On. */
  shut: ReadonlySet<string>;
  /** The Handoffs value `shut` belongs to. */
  handoffs?: boolean;
}

const EMPTY: StepBlocks = { opened: new Set(), shut: new Set() };

export function isBlockOpen(blocks: StepBlocks, id: string, handoffs: boolean): boolean {
  if (!handoffs) return blocks.opened.has(id);
  return blocks.handoffs !== true || !blocks.shut.has(id);
}

function flip(ids: ReadonlySet<string>, id: string): ReadonlySet<string> {
  const next = new Set(ids);
  if (!next.delete(id)) next.add(id);
  return next;
}

export function toggleBlock(blocks: StepBlocks, id: string, handoffs: boolean): StepBlocks {
  if (!handoffs) return { ...blocks, opened: flip(blocks.opened, id) };
  const shut = blocks.handoffs === true ? blocks.shut : EMPTY.shut;
  return { ...blocks, shut: flip(shut, id), handoffs: true };
}

/** After Handoffs changes: forget the closes of the earlier On period. */
export function syncHandoffs(blocks: StepBlocks, handoffs: boolean): StepBlocks {
  return blocks.handoffs === handoffs ? blocks : { ...blocks, shut: EMPTY.shut, handoffs };
}

const store = new Map<string, StepBlocks>();
const listeners = new Set<() => void>();

function write(rootId: string, blocks: StepBlocks) {
  store.set(rootId, blocks);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useStepBlocks(rootId: string, handoffs: boolean) {
  const blocks = useSyncExternalStore(subscribe, () => store.get(rootId) ?? EMPTY);
  // Before paint, so a block never shows a stale close for a frame.
  useLayoutEffect(() => {
    const current = store.get(rootId) ?? EMPTY;
    const next = syncHandoffs(current, handoffs);
    if (next !== current) write(rootId, next);
  }, [rootId, handoffs]);
  const isOpen = useCallback((id: string) => isBlockOpen(blocks, id, handoffs), [blocks, handoffs]);
  const toggle = useCallback(
    (id: string) => write(rootId, toggleBlock(store.get(rootId) ?? EMPTY, id, handoffs)),
    [rootId, handoffs],
  );
  return { isOpen, toggle };
}
