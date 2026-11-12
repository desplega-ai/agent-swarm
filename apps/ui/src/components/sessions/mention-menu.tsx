/**
 * The composer's `@` and `/` list. `@` searches the Cmd+K palette's
 * providers (agents first, then tasks, workflows, schedules, pages, apps and
 * files); `/` lists skills. The focus stays in the editor: it forwards Up,
 * Down, Enter and Tab here (`onKey`), and Escape closes the list through the
 * editor's suggestion plugin.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useVersionGate } from "@/api/hooks/use-feature-gate";
import { useOptionalStatusContext } from "@/app/status-context";
import { SEARCH_PROVIDERS, type SearchProvider } from "@/components/command-palette/providers";
import { Command, CommandGroup, CommandItem, CommandList } from "@/components/ui/command";
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover";
import { navRequirementMet } from "@/lib/agent-fs/state";
import { rankResults } from "@/lib/command-palette/match";
import type { SearchProviderId } from "@/lib/command-palette/route-meta";
import type { MentionChar } from "@/lib/composer-mentions";
import { useIsAdmin } from "@/lib/use-can";

/** Rows per group. */
const LIMIT = 4;

const PROVIDERS: Record<MentionChar, SearchProviderId[]> = {
  "@": ["agents", "tasks", "workflows", "schedules", "pages", "apps", "files-name"],
  "/": ["skills"],
};

/** Shortest query a provider runs here. A bare `@` lists agents only; a bare `/` lists skills. */
function minQuery(char: MentionChar, id: SearchProviderId): number {
  if (char === "/" || id === "agents") return 0;
  return Math.max(1, SEARCH_PROVIDERS[id].minQuery);
}

export interface MentionMenuState {
  char: MentionChar;
  query: string;
  clientRect: (() => DOMRect | null) | null | undefined;
  pick: (attrs: { href: string; label: string }) => void;
}

/**
 * The providers a trigger searches for this user: the palette's gates, read
 * so that a composer outside the app shell (setup has no status provider)
 * gets agents and tasks instead of a crash.
 */
export function useMentionProviders(char: MentionChar): SearchProviderId[] {
  const isAdmin = useIsAdmin();
  const versionOk = useVersionGate();
  const status = useOptionalStatusContext();
  const open = (gate: SearchProvider["gate"]) => {
    if (!gate) return true;
    if (gate.adminOnly && !isAdmin) return false;
    if (gate.minVersion && !versionOk(gate.minVersion)) return false;
    // Files need Comb, and the app shell's agent-fs provider that comes with the status one.
    if (gate.requires)
      return (
        gate.requires === "comb" &&
        !!status &&
        navRequirementMet("comb", status.data?.agent_fs?.comb)
      );
    return true;
  };
  return PROVIDERS[char].filter((id) => open(SEARCH_PROVIDERS[id].gate));
}

function MentionGroup({
  id,
  query,
  onPick,
  onCount,
}: {
  id: SearchProviderId;
  query: string;
  onPick: (attrs: { href: string; label: string }) => void;
  onCount: (id: SearchProviderId, count: number) => void;
}) {
  const provider = SEARCH_PROVIDERS[id];
  // A few extra rows: the client matcher can drop some.
  const state = provider.useSearch(query, LIMIT + 3);
  const rows = rankResults(state.results, query, provider.clientMatch).slice(0, LIMIT);
  useEffect(() => {
    onCount(id, rows.length);
    return () => onCount(id, 0);
  }, [id, rows.length, onCount]);
  if (rows.length === 0) return null;
  const Icon = provider.icon;
  return (
    <CommandGroup heading={provider.label}>
      {rows.map(({ result }) => (
        <CommandItem
          key={result.id}
          value={`${id}:${result.id}`}
          onSelect={() => onPick({ href: result.href, label: result.title })}
        >
          <Icon />
          <span className="min-w-0 truncate font-medium">{result.title}</span>
          {result.detail ? (
            <span className="ml-auto min-w-0 shrink-0 truncate text-xs text-muted-foreground max-w-[40%]">
              {result.detail}
            </span>
          ) : null}
        </CommandItem>
      ))}
    </CommandGroup>
  );
}

/** Warms the lists a bare `@` and `/` show, from the composer's first focus. */
export function MentionPrefetch() {
  const slash = useMentionProviders("/");
  return (
    <>
      <PrefetchQuery id="agents" />
      {slash.map((id) => (
        <PrefetchQuery key={id} id={id} />
      ))}
    </>
  );
}

function PrefetchQuery({ id }: { id: SearchProviderId }) {
  SEARCH_PROVIDERS[id].useSearch("", LIMIT + 3);
  return null;
}

export function MentionMenu({
  state,
  onKeyRef,
}: {
  state: MentionMenuState;
  /** Set to the key handler the editor calls while this list is open. True: handled. */
  onKeyRef: React.RefObject<((event: KeyboardEvent) => boolean) | null>;
}) {
  const providers = useMentionProviders(state.char).filter(
    (id) => state.query.length >= minQuery(state.char, id),
  );
  const [counts, setCounts] = useState<Partial<Record<SearchProviderId, number>>>({});
  const onCount = useCallback((id: SearchProviderId, count: number) => {
    setCounts((current) => (current[id] === count ? current : { ...current, [id]: count }));
  }, []);
  const hasRows = providers.some((id) => (counts[id] ?? 0) > 0);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const latest = useRef({ hasRows });
  latest.current = { hasRows };
  useEffect(() => {
    onKeyRef.current = (event) => {
      if (!latest.current.hasRows || event.isComposing || event.keyCode === 229) return false;
      if (event.altKey || event.ctrlKey || event.metaKey) return false;
      if (!["ArrowUp", "ArrowDown", "Enter", "Tab"].includes(event.key)) return false;
      // cmdk owns the active row: hand it the key, Tab picks like Enter.
      rootRef.current?.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: event.key === "Tab" ? "Enter" : event.key,
          bubbles: true,
          cancelable: true,
        }),
      );
      return true;
    };
    return () => {
      onKeyRef.current = null;
    };
  }, [onKeyRef]);

  const rectRef = useRef(state.clientRect);
  rectRef.current = state.clientRect;
  const virtualRef = useRef({
    getBoundingClientRect: () => rectRef.current?.() ?? new DOMRect(),
  });

  return (
    <Popover open>
      <PopoverAnchor virtualRef={virtualRef} />
      <PopoverContent
        side="bottom"
        align="start"
        sideOffset={4}
        hideWhenDetached
        // Opened by typing: no open or close motion (apps/ui/CLAUDE.md, Motion).
        // Hidden, not unmounted, while nothing matches: the groups keep searching.
        className={hasRows ? "w-80 p-1 animate-none!" : "hidden"}
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
        // A click on a row keeps the focus (and the caret) in the editor.
        onMouseDown={(event) => event.preventDefault()}
      >
        {/* A new query starts on the first row. */}
        <Command key={`${state.char}${state.query}`} ref={rootRef} shouldFilter={false} loop>
          <CommandList
            label={state.char === "/" ? "Skill suggestions" : "Mention suggestions"}
            className="max-h-72"
          >
            {providers.map((id) => (
              <MentionGroup
                key={id}
                id={id}
                query={state.query}
                onPick={state.pick}
                onCount={onCount}
              />
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
