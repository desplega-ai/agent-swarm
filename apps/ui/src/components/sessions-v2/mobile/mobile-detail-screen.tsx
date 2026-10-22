/**
 * The phone detail screen (SPEC R8.5): a top bar with back, the title (a
 * tap renames it when allowed), the People pill, and "⋯"; one meta line
 * (status, the Done or Later note, tasks, cost); then the turn timeline and
 * the composer bar, pinned above the home indicator and the keyboard.
 *
 * "⋯" opens the action sheet: Mark read or unread, Done, Later…, Move to
 * group…, Rename, Share… (the owner), and Handoffs. Later opens the Later
 * sheet, Move the tree's move sheet, and Share the share sheet.
 *
 * Rename on a phone (UX review R9): the top bar turns into Cancel, the
 * field, and Save. Enter or Save saves, and a blur cancels. Toasts sit
 * above the composer while this screen shows.
 */

import {
  AlarmClock,
  Archive,
  Ellipsis,
  FolderInput,
  Inbox,
  ListTree,
  Mail,
  MailOpen,
  Pencil,
  Share2,
} from "lucide-react";
import {
  type FormEvent,
  type MouseEvent,
  type RefObject,
  useEffect,
  useRef,
  useState,
} from "react";
import { sessionErrorStatus, useSession, useSessionShares } from "@/api/hooks/use-sessions";
import type { SessionDetailResponse, SessionListItem } from "@/api/types";
import { SessionConversation } from "@/components/sessions/session-conversation";
import {
  SessionPresenceProvider,
  useSessionPresenceContext,
} from "@/components/sessions/session-presence";
import { ShareSessionButton } from "@/components/sessions/share-session-dialog";
import { StatusBadge } from "@/components/shared/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useLocalToggle } from "@/hooks/use-local-toggle";
import { peerColorVar } from "@/lib/comb/presence";
import { sessionDisplayTitle } from "@/lib/utils";
import { PeoplePill } from "../pane/people-pill";
import { useSessionItem } from "../pane/session-header";
import { TriageNote, useSessionMeta } from "../pane/session-meta-line";
import { TITLE_MAX, useSaveTitle } from "../pane/session-title";
import { useMarkReadOnOpen } from "../pane/use-mark-read-on-open";
import { SnoozeDateDialog } from "../sidebar/snooze-picker";
import { useSessionTriageActions } from "../use-session-triage-actions";
import {
  ActionSheet,
  ActionSheetItem,
  ActionSheetSeparator,
  ActionSheetSwitch,
} from "./action-sheet";
import { MobileTopBar } from "./mobile-top-bar";
import { SnoozeSheet } from "./session-sheets";

type Move = (sessions: SessionListItem[], returnFocus: () => void) => void;

/** Toasts sit this far above the composer's top edge (UX review R9). */
const TOAST_GAP_PX = 8;

/**
 * Lift the phone toasts above the composer while this screen shows: the
 * root Toaster reads `--toast-mobile-bottom` (components/ui/sonner.tsx).
 */
function useToastsAboveComposer(root: RefObject<HTMLElement | null>) {
  useEffect(() => {
    // The composer is the screen's last form (the rename bar comes and goes above it).
    const form = [...(root.current?.querySelectorAll("form") ?? [])].at(-1);
    const style = document.documentElement.style;
    if (!form) return;
    const place = () =>
      style.setProperty(
        "--toast-mobile-bottom",
        `${Math.max(16, window.innerHeight - form.getBoundingClientRect().top + TOAST_GAP_PX)}px`,
      );
    place();
    const observer = new ResizeObserver(place);
    observer.observe(form);
    return () => {
      observer.disconnect();
      style.removeProperty("--toast-mobile-bottom");
    };
  }, [root]);
}

export function MobileDetailScreen({
  rootTaskId,
  onBack,
  onMove,
}: {
  rootTaskId: string;
  onBack: () => void;
  /** The list's move sheet. */
  onMove: Move;
}) {
  // The conversation polls this session: the top bar reads the same cache with no timer.
  const { data: detail, isLoading, error } = useSession(rootTaskId, { poll: "off" });
  useMarkReadOnOpen(detail);
  const [showHandoffs, setShowHandoffs] = useLocalToggle("sessions:show-internal-handoffs", false);
  const noAccess = sessionErrorStatus(error) === 403;
  const root = useRef<HTMLDivElement>(null);
  useToastsAboveComposer(root);
  return (
    <SessionPresenceProvider rootTaskId={rootTaskId} enabled={!!detail}>
      <div ref={root} className="contents">
        {detail && !noAccess ? (
          <DetailHeader
            detail={detail}
            showHandoffs={showHandoffs}
            onShowHandoffs={setShowHandoffs}
            onBack={onBack}
            onMove={onMove}
          />
        ) : (
          <MobileTopBar onBack={onBack}>
            {isLoading ? <Skeleton className="h-5 w-48" /> : null}
          </MobileTopBar>
        )}
        <SessionConversation
          rootTaskId={rootTaskId}
          showInternalHandoffs={showHandoffs}
          timeline="turns"
          scrollClassName="px-4 py-4"
          composer={{
            bar: true,
            // Above the home indicator. With the keyboard up, the inset is gone.
            className:
              "px-3 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] group-data-[keyboard=open]/screen:pb-2",
          }}
        />
      </div>
    </SessionPresenceProvider>
  );
}

/** One meta line: the status, the Done or Later note, tasks, and cost. */
function MetaLine({
  meta,
  session,
}: {
  meta: ReturnType<typeof useSessionMeta>;
  session: SessionListItem;
}) {
  return (
    <div className="flex h-9 shrink-0 items-center gap-3 overflow-hidden border-b border-border-subtle px-4 text-data whitespace-nowrap text-muted-foreground">
      <span className="flex shrink-0">
        <StatusBadge status={meta.status} />
      </span>
      <TriageNote session={session} />
      <span className="shrink-0 font-mono tabular-nums">{meta.tasks}</span>
      {meta.cost ? <span className="shrink-0 font-mono tabular-nums">{meta.cost}</span> : null}
    </div>
  );
}

/** A tap that keeps the focus in the rename field, so its blur does not cancel. */
const keepFocus = (event: MouseEvent) => event.preventDefault();

/**
 * The rename top bar: Cancel, the field, and Save. Enter or Save saves.
 * A blur cancels on a phone (iOS blurs the field when the keyboard closes),
 * so Cancel and Save keep the focus in the field.
 */
function RenameBar({
  detail,
  autoFocus,
  inputRef,
  onDone,
}: {
  detail: SessionDetailResponse;
  /** Off when "Rename" in the "⋯" sheet started it: the closing sheet gives the focus. */
  autoFocus: boolean;
  inputRef: RefObject<HTMLInputElement | null>;
  onDone: (title: string | null) => void;
}) {
  const [draft, setDraft] = useState(detail.root.title ?? "");
  const changed = draft.trim() !== (detail.root.title ?? "");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) onDone(draft);
  };
  return (
    <form
      onSubmit={submit}
      className="flex h-14 shrink-0 items-center gap-1 border-b border-border-subtle px-1"
    >
      <Button
        type="button"
        variant="ghost"
        className="h-11 px-3 text-base text-muted-foreground"
        onMouseDown={keepFocus}
        onClick={() => onDone(null)}
      >
        Cancel
      </Button>
      <Input
        ref={inputRef}
        autoFocus={autoFocus}
        aria-label="Session title"
        value={draft}
        maxLength={TITLE_MAX}
        autoComplete="off"
        enterKeyHint="done"
        placeholder={sessionDisplayTitle({ task: detail.root.task })}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={(event) => {
          // The focus moved to Cancel or Save (a key, not a tap): they act themselves.
          if (event.currentTarget.form?.contains(event.relatedTarget as Node | null)) return;
          onDone(null);
        }}
        className="h-11 min-w-0 flex-1 text-base md:text-base"
      />
      <Button
        type="submit"
        variant="ghost"
        aria-disabled={!changed}
        onMouseDown={keepFocus}
        className="h-11 px-3 text-base font-semibold text-primary aria-disabled:opacity-50"
      >
        Save
      </Button>
    </form>
  );
}

function DetailHeader({
  detail,
  showHandoffs,
  onShowHandoffs,
  onBack,
  onMove,
}: {
  detail: SessionDetailResponse;
  showHandoffs: boolean;
  onShowHandoffs: (on: boolean) => void;
  onBack: () => void;
  onMove: Move;
}) {
  const session = useSessionItem(detail);
  const meta = useSessionMeta(detail);
  const title = sessionDisplayTitle(detail.root);
  const pillRef = useRef<HTMLButtonElement>(null);
  const actionsRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLButtonElement>(null);
  const renameRef = useRef<HTMLInputElement>(null);
  const { viewers } = useSessionPresenceContext();
  // "sheet": "Rename" in the "⋯" sheet started it, so the field takes the focus when the sheet is gone.
  const [renaming, setRenaming] = useState<"title" | "sheet" | null>(null);
  const endedRename = useRef(false);
  const saveTitle = useSaveTitle(detail);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [laterOpen, setLaterOpen] = useState(false);
  const [dateOpen, setDateOpen] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  // The rename ended: the focus goes back to the title.
  useEffect(() => {
    if (renaming || !endedRename.current) return;
    endedRename.current = false;
    titleRef.current?.focus({ preventScroll: true });
  }, [renaming]);

  const { access, owner } = detail;
  // The owner and Can edit rename (SPEC R8.2). An older server sends no access: full access.
  const canRename = access !== "read";
  const shareOwner = access === "owner" && owner ? owner : null;
  const shares = useSessionShares(detail.root.id, shareOwner !== null);
  const { canTriage, actions, doneOrBack, laterOrBack } = useSessionTriageActions({
    pickDate: () => setDateOpen(true),
    // The move sheet gives the focus back to "⋯".
    pickGroup: (sessions) => onMove(sessions, () => actionsRef.current?.focus()),
  });
  const targets = [session];
  const unread = session.readState === "unread";
  const inDone = session.readState === "done";
  const inLater = session.readState === "later";

  return (
    <>
      {renaming ? (
        <RenameBar
          detail={detail}
          autoFocus={renaming === "title"}
          inputRef={renameRef}
          onDone={(typed) => {
            endedRename.current = true;
            setRenaming(null);
            saveTitle(typed);
          }}
        />
      ) : (
        <MobileTopBar
          onBack={onBack}
          backLabel="Back to sessions"
          actions={
            <>
              <span className="relative flex">
                <PeoplePill
                  ref={pillRef}
                  detail={detail}
                  className="h-9 px-3 hit-area [--hit-size:44px]"
                  onShare={shareOwner && shares.data ? () => setShareOpen(true) : undefined}
                />
                {/* Someone else views it now: their color on the pill (UX review R9). */}
                {viewers[0] ? (
                  <span
                    aria-hidden
                    className="absolute -top-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background"
                    style={{ backgroundColor: peerColorVar(viewers[0].color) }}
                  />
                ) : null}
              </span>
              <Button
                ref={actionsRef}
                variant="ghost"
                size="icon"
                aria-label="Session actions"
                aria-haspopup="dialog"
                onClick={() => setActionsOpen(true)}
                className="size-11"
              >
                <Ellipsis className="size-5" />
              </Button>
            </>
          }
        >
          {canRename ? (
            <button
              ref={titleRef}
              type="button"
              aria-label={`${title}. Rename session`}
              onClick={() => setRenaming("title")}
              className="h-11 min-w-0 truncate rounded-sm text-left text-base font-semibold"
            >
              {title}
            </button>
          ) : (
            <h1 className="min-w-0 truncate text-base font-semibold">{title}</h1>
          )}
        </MobileTopBar>
      )}
      <MetaLine meta={meta} session={session} />

      <ActionSheet
        open={actionsOpen}
        onOpenChange={setActionsOpen}
        title={title}
        onCloseAutoFocus={(event) => {
          // "Rename": the field replaced "⋯", so it takes the focus.
          if (renaming !== "sheet") return;
          event.preventDefault();
          renameRef.current?.focus();
        }}
      >
        {canTriage ? (
          <>
            <ActionSheetItem
              icon={unread ? MailOpen : Mail}
              label={unread ? "Mark read" : "Mark unread"}
              onSelect={() => actions.toggleRead(targets)}
            />
            <ActionSheetItem
              icon={inDone ? Inbox : Archive}
              label={inDone ? "Move back to the Inbox" : "Done"}
              onSelect={() => doneOrBack(targets)}
            />
            <ActionSheetItem
              icon={inLater ? Inbox : AlarmClock}
              label={inLater ? "Move back to the Inbox" : "Later…"}
              onSelect={() => laterOrBack(targets, () => setLaterOpen(true))}
            />
          </>
        ) : null}
        <ActionSheetItem
          icon={FolderInput}
          label="Move to group…"
          onSelect={() => actions.move(targets)}
        />
        {canRename ? (
          <ActionSheetItem icon={Pencil} label="Rename" onSelect={() => setRenaming("sheet")} />
        ) : null}
        {shareOwner && shares.data ? (
          <ActionSheetItem icon={Share2} label="Share…" onSelect={() => setShareOpen(true)} />
        ) : null}
        {meta.handoffRows ? (
          <>
            <ActionSheetSeparator />
            <ActionSheetSwitch
              icon={ListTree}
              label="Handoffs"
              checked={showHandoffs}
              onCheckedChange={onShowHandoffs}
            />
          </>
        ) : null}
      </ActionSheet>
      <SnoozeSheet
        open={laterOpen}
        onOpenChange={setLaterOpen}
        what={title}
        onSnooze={(at) => actions.later(targets, at)}
        onPickDate={() => actions.pickDate(targets)}
      />
      <SnoozeDateDialog
        open={dateOpen}
        onOpenChange={setDateOpen}
        onSnooze={(at) => {
          actions.later(targets, at);
          setDateOpen(false);
        }}
        onRestoreFocus={() => actionsRef.current?.focus()}
      />
      {shareOwner ? (
        <ShareSessionButton
          hideTrigger
          rootTaskId={detail.root.id}
          title={title}
          owner={shareOwner}
          open={shareOpen}
          onOpenChange={setShareOpen}
        />
      ) : null}
    </>
  );
}
