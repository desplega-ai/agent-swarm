/**
 * The search field at the top of the sidebar (SPEC R6). Typing filters the
 * sidebar in place (`?q=`, a short pause after the last key). `/` focuses
 * it from anywhere on the page, Escape clears it and gives the focus back
 * to the tree, and the down arrow moves into the results.
 *
 * On a phone (SPEC R8.5) `MobileSearch` draws the field: token chips,
 * suggestions for `with:` and `in:`, and Cancel.
 */

import { type KeyboardEvent, type RefObject, useEffect, useId, useRef, useState } from "react";
import { useKeyboardShortcuts } from "@/components/shared/questions/keyboard";
import { SearchBox } from "@/components/shared/search-box";
import { Kbd } from "@/components/ui/kbd";
import { isTypingTarget, type ShortcutKeyEvent } from "@/lib/approval-shortcuts";
import type { SearchGroup } from "@/lib/session-search";
import { MobileSearch } from "../mobile/mobile-search";

/** Typing pauses this long before the search runs. */
const SEARCH_DEBOUNCE_MS = 250;

/** `/` with no modifier, outside text fields and open overlays. */
function matchSlash(event: ShortcutKeyEvent, { overlayOpen }: { overlayOpen: boolean }) {
  if (event.key !== "/" || event.defaultPrevented || event.isComposing || event.repeat) return null;
  if (event.metaKey || event.ctrlKey || event.altKey || overlayOpen) return null;
  return isTypingTarget(event.target) ? null : ("focus" as const);
}

export function SidebarSearch({
  value,
  onChange,
  onLeave,
  inputRef,
  phone = false,
  groups = [],
  onSearchMode,
}: {
  /** The search in the URL. */
  value: string;
  onChange: (value: string) => void;
  /** Give the focus back to the tree. */
  onLeave: () => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** The phone field (`MobileSearch`): token chips, suggestions, and Cancel. */
  phone?: boolean;
  /** My groups, for the phone's `in:` suggestions. */
  groups?: SearchGroup[];
  /** The phone search mode turned on or off (the list screen hides its top bar). */
  onSearchMode?: (on: boolean) => void;
}) {
  const [text, setText] = useState(value);
  // The last value this field sent. A different URL value came from
  // elsewhere (a link, back, a cleared search) and replaces the text.
  const sent = useRef(value);
  useEffect(() => {
    if (value === sent.current) return;
    sent.current = value;
    setText(value);
  }, [value]);
  useEffect(() => {
    if (text === sent.current) return;
    const timer = window.setTimeout(() => {
      sent.current = text;
      onChange(text);
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [text, onChange]);

  const clear = () => {
    setText("");
    sent.current = "";
    onChange("");
  };
  useKeyboardShortcuts(matchSlash, () => {
    inputRef.current?.focus();
    inputRef.current?.select();
    return true;
  });

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      if (text) clear();
      onLeave();
    } else if (event.key === "ArrowDown" || event.key === "Enter") {
      // Run a waiting search now, then walk the results.
      if (text !== sent.current) {
        sent.current = text;
        onChange(text);
      }
      onLeave();
    } else return;
    event.preventDefault();
  };

  const helpId = useId();
  if (phone) {
    return (
      <MobileSearch
        text={text}
        setText={setText}
        runNow={(next) => {
          setText(next);
          sent.current = next;
          onChange(next);
        }}
        clear={clear}
        onKeyDown={onKeyDown}
        inputRef={inputRef}
        onLeave={onLeave}
        groups={groups}
        onSearchMode={onSearchMode}
      />
    );
  }
  return (
    <search className="shrink-0 px-2 pt-2 pb-1">
      <SearchBox
        size="sm"
        value={text}
        onChange={setText}
        placeholder="Search sessions"
        inputRef={inputRef}
        onKeyDown={onKeyDown}
        describedBy={helpId}
        keyShortcuts="/"
        clearable
        clearLabel="Clear search (Esc)"
        onClear={clear}
        hint={<Kbd aria-hidden>/</Kbd>}
      />
      <p id={helpId} className="sr-only">
        Filters: with:name, in:group, is:unread, is:running, is:needs, is:later, is:done. Escape
        clears.
      </p>
    </search>
  );
}
