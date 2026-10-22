/**
 * "Open in split…" (plan Phase 8, SPEC R2.9): pick the session for the
 * split pane. "New session" comes first, then the open tabs, then the
 * server's matches for the typed text, with the sidebar search tokens
 * (`with:lena`), or the newest Inbox sessions while the field is empty. One
 * cmdk list in a Dialog, on the dialog timing, like the move dialog.
 */

import { AppWindow, Columns2, MessageSquare, Plus } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import { useDebouncedValue } from "@/hooks/use-debounced-value";
import type { SessionSearchParams } from "@/lib/session-search";
import { NEW_SESSION_TAB } from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";
import { focusQuietly } from "../pane/quiet-focus";
import { useServerSessionSearch } from "../use-sessions-commands";
import { useTabInfo } from "./tab-info";

/** With an empty field: the newest sessions in the Inbox. */
const RECENT: SessionSearchParams = { triage: "inbox" };
const LIMIT = 8;

function OpenTabItem({ tab, onPick }: { tab: string; onPick: (id: string) => void }) {
  // The strip's tab polls this session already.
  const info = useTabInfo(tab, null, "off");
  return (
    <CommandItem value={`tab ${tab} ${info.title}`} onSelect={() => onPick(tab)}>
      <AppWindow aria-hidden />
      <span className="min-w-0 truncate">{info.title}</span>
    </CommandItem>
  );
}

export function SplitPicker({
  open,
  tabs,
  onOpenChange,
  onPick,
}: {
  open: boolean;
  /** The session tabs that can move to the split. */
  tabs: string[];
  onOpenChange: (open: boolean) => void;
  /** A session id, or `NEW_SESSION_TAB` for a New session in the split. */
  onPick: (id: string) => void;
}) {
  const [query, setQuery] = useState("");
  const text = useDebouncedValue(query.trim(), 200);
  const { sessions, stale } = useServerSessionSearch(open ? text : "", {
    limit: LIMIT,
    idle: open ? RECENT : undefined,
  });
  // The server answers this text yet: no stale rows as matches, and no "No session matches".
  const searching = query.trim() !== text || stale;
  const others = sessions.filter((session) => !tabs.includes(session.root.id));
  // The control that had the focus before the picker: it gets the focus back.
  const returnTo = useRef<Element | null>(null);
  // The highlighted row. Server rows come in after the typing, and cmdk keeps
  // a highlight on a row that is gone, so Enter would do nothing: after each
  // render, a highlight that is not on screen moves to the first row.
  const [selected, setSelected] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const items = [...(listRef.current?.querySelectorAll("[cmdk-item]") ?? [])];
    if (items.some((item) => item.getAttribute("data-value") === selected)) return;
    const first = items[0]?.getAttribute("data-value");
    if (first) setSelected(first);
  });
  const pick = (id: string) => {
    onOpenChange(false);
    onPick(id);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        showCloseButton={false}
        className="top-[22%] translate-y-0 overflow-hidden p-0 sm:max-w-xl"
        onOpenAutoFocus={() => {
          // The focus has not moved yet: remember where it was.
          returnTo.current = document.activeElement;
        }}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          setQuery("");
          const back = returnTo.current;
          returnTo.current = null;
          if (back instanceof HTMLElement && back.isConnected) focusQuietly(back);
        }}
      >
        <DialogTitle className="sr-only">Open in split</DialogTitle>
        <DialogDescription className="sr-only">Pick a session for the split.</DialogDescription>
        <Command loop value={selected} onValueChange={setSelected}>
          <div className="flex min-w-0 items-center gap-1.5 border-b border-border-subtle px-3 pt-3 pb-2 text-xs font-medium text-muted-foreground">
            <Columns2 aria-hidden className="size-3.5 shrink-0" />
            <span>Open in split</span>
          </div>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Pick a session for the split"
          />
          <CommandList ref={listRef} className="max-h-[360px]">
            {/* Server rows skip the filter, so "No session matches" counts them by hand. */}
            {searching || others.length > 0 ? null : (
              <CommandEmpty>No session matches.</CommandEmpty>
            )}
            <CommandGroup>
              <CommandItem value="new session" onSelect={() => pick(NEW_SESSION_TAB)}>
                <Plus aria-hidden />
                <span>New session</span>
              </CommandItem>
            </CommandGroup>
            {tabs.length > 0 ? (
              <CommandGroup heading="Open tabs">
                {tabs.map((tab) => (
                  <OpenTabItem key={tab} tab={tab} onPick={pick} />
                ))}
              </CommandGroup>
            ) : null}
            {searching && query.trim() ? (
              <output className="block px-3 py-2 text-xs text-muted-foreground">Searching…</output>
            ) : others.length > 0 ? (
              <CommandGroup heading={text ? "Sessions" : "Recent in the Inbox"} forceMount>
                {others.map((session) => (
                  <CommandItem
                    key={session.root.id}
                    // The server matched these on the text: they skip the cmdk filter.
                    forceMount
                    value={`session ${session.root.id} ${sessionDisplayTitle(session.root)}`}
                    onSelect={() => pick(session.root.id)}
                  >
                    <MessageSquare aria-hidden />
                    <span className="min-w-0 truncate">{sessionDisplayTitle(session.root)}</span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null}
          </CommandList>
        </Command>
      </DialogContent>
    </Dialog>
  );
}
