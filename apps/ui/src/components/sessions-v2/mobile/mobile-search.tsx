/**
 * The phone search field (SPEC R8.5, UX review R9): a 44 px field with
 * 16 px text. A tap enters search mode: the list screen hides its top bar,
 * Cancel sits next to the field, and token chips show under it (`with:`,
 * `in:`, `is:unread`, `is:running`). After `with:` or `in:`, 44 px
 * suggestions list the people or my groups that match the value typed so
 * far; a tap completes the token. `SidebarSearch` owns the text and when it
 * runs.
 */

import { Hash } from "lucide-react";
import { type KeyboardEvent, type MouseEvent, type RefObject, useEffect, useState } from "react";
import { useUsers } from "@/api/hooks/use-users";
import { SearchBox } from "@/components/shared/search-box";
import { UserAvatar } from "@/components/shared/user-avatar";
import { Button } from "@/components/ui/button";
import {
  completeToken,
  type QuickFilter,
  quickFilterOn,
  type SearchGroup,
  suggestGroups,
  suggestPeople,
  toggleQuickFilter,
  typingToken,
} from "@/lib/session-search";
import { cn } from "@/lib/utils";

/** The chips: two tokens that take a value, then two quick filters. */
const CHIPS: { label: string; token?: "with:" | "in:"; filter?: QuickFilter }[] = [
  { label: "with:", token: "with:" },
  { label: "in:", token: "in:" },
  { label: "is:unread", filter: "unread" },
  { label: "is:running", filter: "running" },
];

/** At most this many suggestions show, so the results stay in view. */
const MAX_SUGGESTIONS = 6;

/** A tap that keeps the focus in the field, so search mode stays on. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

export function MobileSearch({
  text,
  setText,
  runNow,
  clear,
  onKeyDown,
  inputRef,
  onLeave,
  groups,
  onSearchMode,
}: {
  text: string;
  /** Change the text (the search runs after a short pause). */
  setText: (text: string) => void;
  /** Change the text and run the search now. */
  runNow: (text: string) => void;
  clear: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  /** Give the focus back to the list. */
  onLeave: () => void;
  /** My groups, for `in:`. */
  groups: SearchGroup[];
  onSearchMode?: (on: boolean) => void;
}) {
  // Search mode: the field has the focus or holds text.
  const [focused, setFocused] = useState(false);
  const searching = focused || text !== "";
  useEffect(() => {
    onSearchMode?.(searching);
  }, [searching, onSearchMode]);
  useEffect(() => () => onSearchMode?.(false), [onSearchMode]);

  const token = typingToken(text);
  const users = useUsers({ enabled: token?.kind === "with" });
  const suggestions = !token
    ? []
    : (token.kind === "with"
        ? suggestPeople(
            token.value,
            (users.data ?? []).map((user) => ({ id: user.id, name: user.name })),
          )
        : suggestGroups(token.value, groups)
      ).slice(0, MAX_SUGGESTIONS);

  return (
    <search
      className="shrink-0 px-4 pt-1 pb-2"
      onFocus={() => setFocused(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setFocused(false);
      }}
    >
      <div className="flex items-center gap-2">
        <SearchBox
          value={text}
          onChange={setText}
          placeholder="Search sessions"
          inputRef={inputRef}
          onKeyDown={onKeyDown}
          clearable
          onClear={clear}
          // The 28 px clear button gets a 44 px tap area (UX review R9).
          className="flex-1 [&_button]:after:absolute [&_button]:after:-inset-2 [&_input]:h-11 [&_input]:rounded-lg [&_input]:bg-muted/60 [&_input]:text-base"
        />
        {searching ? (
          <Button
            type="button"
            variant="ghost"
            className="h-11 px-2 text-base text-primary"
            onClick={() => {
              clear();
              setFocused(false);
              inputRef.current?.blur();
              onLeave();
            }}
          >
            Cancel
          </Button>
        ) : null}
      </div>
      {searching ? (
        // The row pads 4 px above and below, so each chip's 44 px touch area fits in it.
        <div className="mt-1 flex gap-2 overflow-x-auto py-1">
          {CHIPS.map(({ label, token: chipToken, filter }) => {
            const on = filter ? quickFilterOn(text, filter) : false;
            return (
              <Button
                key={label}
                type="button"
                variant="outline"
                aria-pressed={filter ? on : undefined}
                onMouseDown={keepFocus}
                onClick={() => {
                  if (filter) runNow(toggleQuickFilter(text, filter));
                  else setText(`${text.trim()} ${chipToken}`.trimStart());
                  inputRef.current?.focus();
                }}
                className={cn(
                  "h-9 shrink-0 rounded-full px-3 font-mono text-data hit-area [--hit-size:44px]",
                  // Over the outline variant's fill, border, and hover in both
                  // themes (iOS keeps the hover after a tap).
                  on &&
                    "border-primary/60 bg-primary/10 text-foreground hover:bg-primary/10 dark:border-primary/60 dark:bg-primary/10 dark:hover:bg-primary/10",
                )}
              >
                {label}
              </Button>
            );
          })}
        </div>
      ) : null}
      {suggestions.length > 0 && token ? (
        <ul aria-label={token.kind === "with" ? "People" : "Groups"} className="mt-1 flex flex-col">
          {suggestions.map((suggestion) => (
            <li key={suggestion.id}>
              <button
                type="button"
                onMouseDown={keepFocus}
                onClick={() => {
                  runNow(completeToken(text, token, suggestion.value));
                  inputRef.current?.focus();
                }}
                className="flex min-h-11 w-full items-center gap-3 rounded-md px-1 text-left text-base active:bg-accent"
              >
                {token.kind === "with" ? (
                  <UserAvatar id={suggestion.id} name={suggestion.label} size="sm" />
                ) : (
                  <Hash aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                )}
                <span className="min-w-0 flex-1 truncate">{suggestion.label}</span>
                <span className="shrink-0 font-mono text-data text-muted-foreground">
                  {token.kind}:{suggestion.value}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </search>
  );
}
