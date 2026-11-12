/**
 * Ask the Lead (step-10): a one-row composer that grows on focus. Send
 * starts a session in this group (`key` = the group key, `source: "ui"`),
 * and the new session opens in a tab. "Attach the open file" names the
 * previewed file in the task. Above the composer, the two newest sessions
 * started from the dashboard in this group, with the latest reply.
 */

import { useQuery } from "@tanstack/react-query";
import { ArrowUp, MessageCircle, Paperclip } from "lucide-react";
import { useState } from "react";
import { sessionsQueryOptions } from "@/api/hooks/use-sessions";
import { useStartSession } from "@/components/sessions/use-start-session";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useCurrentUser } from "@/contexts/current-user-context";
import { baseName } from "@/lib/comb/paths";
import { isCoarsePointerInput, shouldSubmitOnEnterKeyDown } from "@/lib/enter-submit";
import { cn, sessionDisplayTitle } from "@/lib/utils";
import { shortAgo } from "../sidebar/session-row";
import { BlockedHint } from "./run-now";
import { Widget } from "./widget";

/** The task text: what was typed, plus the attached file's drive path. */
export function askLeadTask(typed: string, file: string | null): string {
  if (!file) return typed;
  return `${typed}\n\nAbout the file \`${file}\` in the shared drive.`;
}

export function AskLeadWidget({
  groupKey,
  file,
  now,
  onOpen,
  writeBlock,
}: {
  groupKey: string;
  /** The drive path of the previewed file, if any. */
  file: string | null;
  now: number;
  onOpen: (rootTaskId: string) => void;
  /** Why this connection cannot start a session in the group, if it cannot. */
  writeBlock: string | null;
}) {
  const { userId } = useCurrentUser();
  const [attach, setAttach] = useState(true);
  const attached = attach ? file : null;
  const start = useStartSession({
    key: groupKey,
    draftKey: `ask-lead:${groupKey}`,
    onStarted: (created) => onOpen(created.id),
    buildTask: (typed) => askLeadTask(typed, attached),
  });
  const replies = useQuery(
    sessionsQueryOptions(userId ?? null, { scope: "tree", groupKey, source: ["ui"], limit: 2 }),
  ).data?.sessions;
  const { value, onChange, onSubmit, isPending } = start.composerProps;
  const canSend = !writeBlock && !isPending && value.trim().length > 0;

  return (
    <Widget
      icon={MessageCircle}
      title="Ask the Lead"
      label="Ask the Lead"
      count={<span className="font-sans">Starts a session in this group</span>}
    >
      {replies && replies.length > 0 ? (
        <ul aria-label="Recent questions in this group" className="p-1.5">
          {replies.map((session) => (
            <li key={session.root.id}>
              <button
                type="button"
                onClick={() => onOpen(session.root.id)}
                className="flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-xs hover:bg-accent/60"
              >
                <span
                  aria-hidden
                  className="grid size-5 shrink-0 place-items-center rounded-full bg-muted text-meta font-semibold text-muted-foreground"
                >
                  L
                </span>
                <span className="min-w-0 flex-1 truncate">
                  {session.preview?.trim() || sessionDisplayTitle(session.root)}
                </span>
                <span className="shrink-0 font-mono tabular-nums text-muted-foreground">
                  {shortAgo(session.lastActivityAt, now)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (canSend) onSubmit();
        }}
        className="flex items-end gap-2 border-t border-border-subtle p-2.5 first:border-t-0"
      >
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 rounded-md border border-input bg-background px-2.5 py-1.5 focus-within:ring-2 focus-within:ring-ring/60">
          <Textarea
            value={value}
            onChange={(event) => onChange(event.target.value)}
            onKeyDown={(event) => {
              const submit = shouldSubmitOnEnterKeyDown(
                {
                  key: event.key,
                  shiftKey: event.shiftKey,
                  metaKey: event.metaKey,
                  ctrlKey: event.ctrlKey,
                  isComposing: event.nativeEvent.isComposing,
                  keyCode: event.nativeEvent.keyCode,
                },
                isCoarsePointerInput(),
              );
              if (!submit) return;
              event.preventDefault();
              if (canSend) onSubmit();
            }}
            disabled={!!writeBlock}
            rows={1}
            aria-label="Ask the Lead"
            placeholder={writeBlock ?? "Ask a question or ask for a change"}
            // It grows on focus and stays grown while it holds text, so a
            // click on Send never lands on a box that shrinks under the pointer.
            className={cn(
              "field-sizing-content max-h-40 min-h-6 resize-none border-0 bg-transparent p-0 text-sm shadow-none focus-visible:ring-0 dark:bg-transparent",
              value ? "min-h-16" : "[&:focus]:min-h-16",
            )}
          />
          {file ? (
            <button
              type="button"
              aria-pressed={attach}
              onClick={() => setAttach((on) => !on)}
              title={attach ? "Attached. Click to leave it out." : "Attach the open file"}
              className={cn(
                "flex w-fit max-w-full items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-meta",
                attach
                  ? "border-border bg-muted text-foreground"
                  : "border-dashed border-border text-muted-foreground line-through",
              )}
            >
              <Paperclip aria-hidden className="size-3 shrink-0" />
              <span className="truncate">{baseName(file)}</span>
            </button>
          ) : null}
        </div>
        <BlockedHint reason={writeBlock}>
          <Button
            type="submit"
            size="icon-sm"
            aria-label="Send to the Lead"
            aria-disabled={!canSend || undefined}
            className="shrink-0 aria-disabled:opacity-50"
          >
            <ArrowUp />
          </Button>
        </BlockedHint>
      </form>
      {start.composerProps.isError ? (
        <p role="alert" className="px-3.5 pb-2.5 text-xs text-status-error-strong">
          {start.composerProps.errorMessage ?? "The session did not start. Try again."}
        </p>
      ) : null}
    </Widget>
  );
}
