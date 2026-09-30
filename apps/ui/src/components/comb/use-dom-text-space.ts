import { type RefObject, useEffect, useState } from "react";
// Relative: `bun:test` runs this module from the repo root.
import { buildDomTextSpace, type DomTextSpace } from "../../lib/comb/dom-text-space";

type Listener = (space: DomTextSpace | null) => void;

/** One text space per viewer pane, and everyone who reads it. */
interface SharedSpace {
  space: DomTextSpace | null;
  listeners: Set<Listener>;
  stop: () => void;
}

const shared = new WeakMap<HTMLElement, SharedSpace>();

function attach(root: HTMLElement): SharedSpace {
  const existing = shared.get(root);
  if (existing) return existing;
  let frame = 0;
  // Content changes only. Highlight fallback classes change attributes, which
  // must not trigger a rebuild.
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(rebuild);
  });
  const entry: SharedSpace = {
    space: null,
    listeners: new Set(),
    stop: () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
      shared.delete(root);
    },
  };
  function rebuild() {
    frame = 0;
    entry.space = root.querySelector("[data-line-start]") ? buildDomTextSpace(root) : null;
    for (const listener of entry.listeners) listener(entry.space);
  }
  observer.observe(root, { childList: true, subtree: true, characterData: true });
  frame = requestAnimationFrame(rebuild);
  shared.set(root, entry);
  return entry;
}

/**
 * Follow the text space of `root`. Every reader of one pane (the comment
 * rail, the presence layer) shares one observer and one build per change.
 * The listener gets the current space at once, then every rebuild. Returns
 * the unsubscribe; the last one stops the observer.
 */
export function subscribeTextSpace(root: HTMLElement, listener: Listener): () => void {
  const entry = attach(root);
  entry.listeners.add(listener);
  listener(entry.space);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size === 0) entry.stop();
  };
}

/**
 * The text space of whatever the viewer pane shows, rebuilt when its DOM
 * changes (the file loads, a new version renders). Null until the pane holds
 * blocks with source lines (`data-line-start`), so media viewers and loading
 * skeletons never anchor comments.
 */
export function useDomTextSpace(rootRef: RefObject<HTMLElement | null>): DomTextSpace | null {
  const [space, setSpace] = useState<DomTextSpace | null>(null);

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    return subscribeTextSpace(root, setSpace);
  }, [rootRef]);

  return space;
}
