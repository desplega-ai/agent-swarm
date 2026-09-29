/**
 * The panel's session picker: a popover with a search box, "New session", and
 * the page's earlier sessions. Search and order are the API's: `query` goes to
 * `GET /api/sessions?q=` (debounced by the caller) and rows render in the
 * order the endpoint returns them, newest activity first.
 */

import { ChevronsUpDown, Plus, Search } from "lucide-react";
import { type ReactNode, useState } from "react";
import type { SessionListItem } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn, formatRelativeTime } from "@/lib/utils";
import { sessionLabel } from "./model";

export const NEW_SESSION = "__new__";

export interface SessionPickerProps {
  /** `NEW_SESSION` or a root task id. */
  selected: string;
  /** Trigger text for the selected session. */
  selectedLabel: string;
  sessions: SessionListItem[];
  isLoading: boolean;
  query: string;
  onQueryChange: (query: string) => void;
  onSelect: (value: string) => void;
  disabled?: boolean;
}

export function SessionPicker({
  selected,
  selectedLabel,
  sessions,
  isLoading,
  query,
  onQueryChange,
  onSelect,
  disabled,
}: SessionPickerProps) {
  const [open, setOpen] = useState(false);
  const pick = (value: string) => {
    setOpen(false);
    onSelect(value);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label="Sessions for this page"
          disabled={disabled}
          className="h-9 w-full justify-between px-3 text-xs font-normal"
        >
          <span className="truncate">{selectedLabel}</span>
          <ChevronsUpDown className="size-3.5 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <div className="relative border-b border-border p-2">
          <Search className="absolute left-4 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input
            autoFocus
            value={query}
            onChange={(e) => onQueryChange(e.target.value)}
            placeholder="Search sessions"
            aria-label="Search sessions"
            className="h-8 pl-7 text-xs"
          />
        </div>
        <ul className="max-h-[50vh] overflow-auto p-1" aria-label="Sessions">
          <li>
            <PickerRow active={selected === NEW_SESSION} onClick={() => pick(NEW_SESSION)}>
              <Plus className="size-3.5 shrink-0" />
              <span className="truncate">New session</span>
            </PickerRow>
          </li>
          {sessions.map((s) => (
            <li key={s.root.id} data-session-id={s.root.id}>
              <PickerRow active={selected === s.root.id} onClick={() => pick(s.root.id)}>
                <span className="min-w-0 flex-1 truncate">{sessionLabel(s.root)}</span>
                <time
                  dateTime={s.lastActivityAt}
                  className="shrink-0 text-[11px] text-muted-foreground"
                >
                  {formatRelativeTime(s.lastActivityAt)}
                </time>
              </PickerRow>
            </li>
          ))}
          {sessions.length === 0 ? (
            <li className="px-2 py-3 text-center text-xs text-muted-foreground">
              {isLoading
                ? "Loading sessions…"
                : query.trim()
                  ? "No sessions match."
                  : "No sessions on this page yet."}
            </li>
          ) : null}
        </ul>
      </PopoverContent>
    </Popover>
  );
}

function PickerRow({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-xs",
        "hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:outline-none",
        active && "bg-accent/60",
      )}
    >
      {children}
    </button>
  );
}
