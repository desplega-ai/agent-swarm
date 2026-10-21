/**
 * The session title in the header (SPEC R8.2, R10.3): one line with an
 * ellipsis and the full title in a tooltip, and the inline rename. The
 * pencil (on hover or focus), a double-click, or Cmd+K "Rename session"
 * turns it into the rename field. Only the owner and Can edit rename.
 */

import { Pencil } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { useUpdateSessionTitle } from "@/api/hooks/use-sessions";
import type { SessionDetailResponse } from "@/api/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { SESSIONS_TOAST_POSITION } from "@/lib/sessions-v2";
import { sessionDisplayTitle } from "@/lib/utils";
import { TruncatedTitle } from "../truncated-title";
import { focusQuietly, useQuietTooltip } from "./quiet-focus";

/** The rename limit of `PATCH /api/tasks/{id}/title`. */
export const TITLE_MAX = 120;

/**
 * The rename field. Enter or a blur saves, Escape cancels. `onDone(title,
 * refocus)` ends the edit: the typed title, or null to cancel. A key asks
 * for the focus back on the pencil.
 */
function TitleField({
  current,
  placeholder,
  onDone,
}: {
  current: string;
  /** The first message: an empty title shows it again. */
  placeholder: string;
  onDone: (title: string | null, refocus: boolean) => void;
}) {
  const [draft, setDraft] = useState(current);
  const ref = useRef<HTMLInputElement>(null);
  const hintId = useId();
  // An Escape can still blur the field as it goes: end once.
  const ended = useRef(false);
  // An effect, not `autoFocus`: from Cmd+K, the closing palette holds its
  // focus trap until the effects run.
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);

  const end = (save: boolean, refocus: boolean) => {
    if (ended.current) return;
    ended.current = true;
    onDone(save ? draft : null, refocus);
  };

  return (
    <>
      <Input
        ref={ref}
        aria-label="Session title"
        aria-describedby={hintId}
        value={draft}
        maxLength={TITLE_MAX}
        autoComplete="off"
        placeholder={placeholder}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={() => end(true, false)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== "Escape") return;
          event.preventDefault();
          end(event.key === "Enter", true);
        }}
        className="-ml-1.5 h-8 px-1.5 text-lg font-semibold tracking-tight md:text-lg"
      />
      <span id={hintId} className="sr-only">
        Enter saves, Escape cancels. An empty title shows the first message.
      </span>
    </>
  );
}

/**
 * Save a typed title: null or the same title saves nothing, and an empty
 * title clears the override (the session shows its first message again).
 * Saved here, not in the field: the field is gone before the server
 * answers. The promise also settles when a switch to another session
 * unmounts the header (a `mutate` callback would not run then).
 */
export function useSaveTitle(detail: SessionDetailResponse) {
  const updateTitle = useUpdateSessionTitle();
  return (typed: string | null) => {
    const next = typed?.trim();
    if (next === undefined || next === (detail.root.title ?? "")) return;
    void updateTitle.mutateAsync({ id: detail.root.id, title: next || null }).then(
      () => toast("Renamed", { position: SESSIONS_TOAST_POSITION }),
      (error: unknown) =>
        toast.error(error instanceof Error ? error.message : "Couldn't rename the session", {
          position: SESSIONS_TOAST_POSITION,
        }),
    );
  };
}

export function SessionTitle({
  detail,
  canRename,
  renaming,
  onRenamingChange,
}: {
  detail: SessionDetailResponse;
  canRename: boolean;
  /** The title is the rename field. */
  renaming: boolean;
  onRenamingChange: (renaming: boolean) => void;
}) {
  const title = sessionDisplayTitle(detail.root);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const pencilTip = useQuietTooltip();
  const refocusPencil = useRef(false);
  // A key ended the rename: the focus goes back to the pencil, with no tooltip over row 1.
  useEffect(() => {
    if (renaming || !refocusPencil.current) return;
    refocusPencil.current = false;
    focusQuietly(pencilRef.current);
  }, [renaming]);
  const startRename = () => onRenamingChange(true);

  const saveTitle = useSaveTitle(detail);
  const endRename = (typed: string | null, refocus: boolean) => {
    refocusPencil.current = refocus;
    onRenamingChange(false);
    saveTitle(typed);
  };

  if (renaming && canRename) {
    return (
      <TitleField
        current={detail.root.title ?? ""}
        placeholder={sessionDisplayTitle({ task: detail.root.task })}
        onDone={endRename}
      />
    );
  }
  return (
    <>
      <h2 className="min-w-0 text-lg leading-tight font-semibold tracking-tight">
        <TruncatedTitle title={title} onDoubleClick={canRename ? startRename : undefined} />
      </h2>
      {canRename ? (
        // In at once on hover or focus, out with the linger (UX review R9).
        <span className="flex shrink-0 opacity-0 transition-opacity delay-50 duration-200 ease-snappy group-hover/header:opacity-100 group-hover/header:delay-0 group-hover/header:duration-0 focus-within:opacity-100 focus-within:delay-0 focus-within:duration-0">
          <Tooltip {...pencilTip}>
            <TooltipTrigger asChild>
              <Button
                ref={pencilRef}
                size="icon-xs"
                variant="ghost"
                aria-label="Rename session"
                onClick={startRename}
                className="text-muted-foreground hover:text-foreground"
              >
                <Pencil className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Rename session</TooltipContent>
          </Tooltip>
        </span>
      ) : null}
    </>
  );
}
