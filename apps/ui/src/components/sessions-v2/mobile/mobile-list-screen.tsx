/**
 * The phone list screen (SPEC R8.5): one top row with the "Sessions" title,
 * the search icon, the filter, New session, and "⋯" (Legacy sessions, the
 * theme, the guide), then the sidebar tree at full width in its phone form:
 * the same sections as desktop, and touch rows. In search mode the field
 * and its Cancel take the top row. While a pushed screen covers it, it is
 * inert and keeps its scroll position.
 */

import { CircleHelp, Ellipsis, LayoutList, Moon, SquarePen, Sun } from "lucide-react";
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
  const { theme, toggleTheme } = useTheme();
  return (
    <div
      inert={covered}
      aria-hidden={covered || undefined}
      data-phone-screen="list"
      // `touch-manipulation`: a double tap does not zoom the page in.
      className="relative flex min-h-0 flex-1 touch-manipulation flex-col bg-background"
    >
      <SessionTree
        phone
        phoneActions={
          <>
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
          </>
        }
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
          icon={LayoutList}
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
