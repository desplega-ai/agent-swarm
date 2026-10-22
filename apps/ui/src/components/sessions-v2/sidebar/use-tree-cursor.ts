import { type FocusEvent, type RefObject, useEffect, useState } from "react";
import type { NavRow } from "./tree-rows";

/** The keyboard cursor rests this long before its hover card opens. */
const PEEK_DELAY_MS = 450;

interface Cursor {
  key: string;
  /** Where it was: when its row leaves, the row that moved up into this place takes it. */
  index: number;
}

/**
 * The keyboard cursor of the sidebar tree. The tree keeps the focus and
 * points at the cursor row (`aria-activedescendant`), so rows can leave
 * (Done, Later, a poll) and the cursor stays put: the next row moves up
 * into it. Keys put the tree in keyboard mode (the cursor shows, its hover
 * card peeks), a pointer press takes it out.
 */
export function useTreeCursor({
  navRows,
  focused,
  treeRef,
  domId,
  menuOpen,
}: {
  navRows: NavRow[];
  /** The session in the focused pane: the first focus starts on its row. */
  focused: string;
  treeRef: RefObject<HTMLElement | null>;
  domId: (key: string) => string;
  menuOpen: boolean;
}) {
  const [cursor, setCursor] = useState<Cursor | null>(null);
  const found = cursor ? navRows.findIndex((row) => row.key === cursor.key) : -1;
  const cursorIndex =
    found >= 0
      ? found
      : cursor && navRows.length > 0
        ? Math.min(cursor.index, navRows.length - 1)
        : -1;
  const cursorRow = cursorIndex >= 0 ? navRows[cursorIndex] : null;
  const cursorKey = cursorRow?.key ?? null;

  // Follow the row list: a moved row keeps the cursor, a gone row hands it on.
  useEffect(() => {
    if (cursorKey === null) return;
    setCursor((prev) =>
      prev?.key === cursorKey && prev.index === cursorIndex
        ? prev
        : { key: cursorKey, index: cursorIndex },
    );
  }, [cursorKey, cursorIndex]);

  const [kb, setKb] = useState(false);
  const [treeFocused, setTreeFocused] = useState(false);
  const keyboard = kb && treeFocused;

  // Keys move the cursor into view. Scroll the list only: `scrollIntoView`
  // would also move the page.
  useEffect(() => {
    const tree = treeRef.current;
    const row = cursorKey ? document.getElementById(domId(cursorKey)) : null;
    if (!keyboard || !tree || !row) return;
    const box = tree.getBoundingClientRect();
    const rect = row.getBoundingClientRect();
    if (rect.top < box.top) tree.scrollTop -= box.top - rect.top;
    else if (rect.bottom > box.bottom) tree.scrollTop += rect.bottom - box.bottom;
  }, [keyboard, cursorKey, treeRef, domId]);

  // The cursor rests on a session: its hover card opens, as on hover.
  const [peekKey, setPeekKey] = useState<string | null>(null);
  const peekable = keyboard && cursorRow?.type === "session" && !menuOpen;
  useEffect(() => {
    setPeekKey(null);
    if (!peekable || !cursorKey) return;
    const timer = window.setTimeout(() => setPeekKey(cursorKey), PEEK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [peekable, cursorKey]);

  /** Put the cursor on a row (a click). */
  const place = (key: string) => {
    setCursor({
      key,
      index: Math.max(
        0,
        navRows.findIndex((row) => row.key === key),
      ),
    });
  };
  /** Move the cursor by keys. */
  const moveTo = (index: number) => {
    if (navRows.length === 0) return;
    setKb(true);
    const at = Math.max(0, Math.min(navRows.length - 1, index));
    setCursor({ key: navRows[at].key, index: at });
  };

  const onFocus = (event: FocusEvent<HTMLElement>) => {
    setTreeFocused(true);
    // A Tab into the list shows the cursor at once.
    if (event.target === event.currentTarget && event.currentTarget.matches(":focus-visible")) {
      setKb(true);
    }
    if (cursorRow || navRows.length === 0) return;
    // The first focus starts on the open session's row, else on the first row.
    const open = navRows.findIndex(
      (row) => row.type === "session" && row.session.root.id === focused,
    );
    const at = Math.max(0, open);
    setCursor({ key: navRows[at].key, index: at });
  };
  const onBlur = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) setTreeFocused(false);
  };

  return {
    cursorRow,
    cursorIndex,
    keyboard,
    peekKey,
    closePeek: () => setPeekKey(null),
    place,
    moveTo,
    /** Keys drive the tree (also for keys that do not move the cursor). */
    enterKeyMode: () => setKb(true),
    onFocus,
    onBlur,
    /** A pointer press hands the tree back to the pointer. */
    onPointerDown: () => setKb(false),
  };
}
