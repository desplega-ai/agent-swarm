/**
 * The phone list screen (SPEC R8.5): a large "Sessions" title with New
 * session and "⋯" (Legacy sessions, the theme, the guide), then the
 * sidebar tree at full width in its phone form: the search with token
 * chips, the same sections as desktop, and touch rows. In search mode the
 * large title and its actions give way to the field and its Cancel. While a
 * pushed screen covers it, it is inert and keeps its scroll position.
 */

import { CircleHelp, Ellipsis, History, Moon, SquarePen, Sun } from "lucide-react";
import { type RefObject, useState } from "react";
import { Button } from "@/components/ui/button";
import type { SessionsViewMode } from "@/hooks/use-sessions-view";
import { useTheme } from "@/hooks/use-theme";
import { SessionTree, type SessionTreeHandle } from "../sidebar/session-tree";
import { ActionSheet, ActionSheetItem } from "./action-sheet";

export function MobileListScreen({
  covered,
  focused,
  query,
  setQuery,
  openSession,
  newSession,
  setView,
  onViewChange,
  showGuide,
  treeRef,
}: {
  /** A pushed screen lies over this one. */
  covered: boolean;
  /** The session on the detail screen, or "". */
  focused: string;
  query: string;
  setQuery: (query: string) => void;
  openSession: (id: string) => void;
  newSession: (group?: string | null) => void;
  setView: (view: string) => void;
  onViewChange: (view: SessionsViewMode) => void;
  showGuide: () => void;
  treeRef: RefObject<SessionTreeHandle | null>;
}) {
  const [moreOpen, setMoreOpen] = useState(false);
  // Search mode: the field moves up and its Cancel replaces these actions (iOS Mail).
  const [searching, setSearching] = useState(false);
  const { theme, toggleTheme } = useTheme();
  return (
    <div
      inert={covered}
      aria-hidden={covered || undefined}
      data-phone-screen="list"
      className="relative flex min-h-0 flex-1 flex-col bg-background"
    >
      {searching ? null : (
        <header className="flex h-14 shrink-0 items-center gap-1 pr-1 pl-4">
          <h1 className="min-w-0 flex-1 truncate text-2xl font-semibold tracking-tight">
            Sessions
          </h1>
          <Button
            variant="ghost"
            size="icon"
            aria-label="New session"
            onClick={() => newSession(null)}
            className="size-11"
          >
            <SquarePen className="size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="More"
            aria-haspopup="dialog"
            onClick={() => setMoreOpen(true)}
            className="size-11"
          >
            <Ellipsis className="size-5" />
          </Button>
        </header>
      )}
      <SessionTree
        phone
        onSearchMode={setSearching}
        focused={focused}
        openSession={(id) => openSession(id)}
        newSession={newSession}
        setView={setView}
        query={query}
        setQuery={setQuery}
        onViewChange={onViewChange}
        // The title is renamed on the detail screen.
        onRename={() => {}}
        paneCommands={{
          // A phone has no split: open the session.
          openInSplit: openSession,
          pickSplit: () => {},
          showGuide,
        }}
        ref={treeRef}
      />
      <ActionSheet open={moreOpen} onOpenChange={setMoreOpen} title="Sessions">
        <ActionSheetItem
          icon={History}
          label="Legacy sessions"
          onSelect={() => onViewChange("legacy")}
        />
        <ActionSheetItem
          icon={theme === "dark" ? Sun : Moon}
          label={theme === "dark" ? "Light theme" : "Dark theme"}
          onSelect={toggleTheme}
        />
        <ActionSheetItem icon={CircleHelp} label="Show the guide" onSelect={showGuide} />
      </ActionSheet>
    </div>
  );
}
