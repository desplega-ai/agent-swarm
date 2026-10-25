import { CheckCheck, MessageSquare, Send, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { toast } from "sonner";
import { useBulkResolve, useFolderThreads } from "@/api/hooks/use-agent-fs";
import { SendBatchDialog } from "@/components/comb/send-to-swarm";
import { useAuthorLabel } from "@/components/comb/use-author-label";
import { useCombServiceUserId } from "@/components/comb/use-comb-service-user";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useAgentFs } from "@/contexts/agent-fs-context";
import type { CommentListEntry } from "@/lib/agent-fs/types";
import { eligibleForBatch } from "@/lib/comb/batch";
import {
  AGE_FILTERS,
  type AgeFilter,
  bulkSummary,
  matchesAge,
  pruneSelection,
  selectionState,
  setAll,
} from "@/lib/comb/bulk";
import { commentCombPath } from "@/lib/comb/comments";
import { isSentToSwarm } from "@/lib/comb/markers";
import { combPath, type DrivePath } from "@/lib/comb/paths";
import type { ThreadSwarmState } from "@/lib/comb/thread-status";
import { SwarmStateTag } from "./swarm-state";
import { useThreadSwarmStates } from "./use-thread-swarm-states";

const NO_THREADS: CommentListEntry[] = [];

/**
 * The folder's "Open comments" panel: open threads grouped by file, each with
 * its swarm state (Processing or Sent). Check comments (one, a file's, or all
 * shown) to send them to the swarm or resolve them in bulk. The age filter
 * narrows the list to old comments. Hidden when agent-fs lacks the
 * `comment-path-prefix` feature or the folder has no open comments.
 */
export function FolderComments({ folder }: { folder: DrivePath }) {
  const { features } = useAgentFs();
  const supported = features.has("comment-path-prefix");
  const query = useFolderThreads(folder, supported);
  const authorLabel = useAuthorLabel(folder);
  const serviceUserId = useCombServiceUserId();
  const threads = query.data?.threads ?? NO_THREADS;
  const states = useThreadSwarmStates(threads);
  const bulk = useBulkResolve(folder);
  const [age, setAge] = useState<AgeFilter>("any");
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [sending, setSending] = useState<CommentListEntry[] | null>(null);

  // The age filter reads the clock once per list change, not on every render.
  const shown = useMemo(() => {
    const now = Date.now();
    return threads.filter((thread) => matchesAge(thread, age, now));
  }, [threads, age]);
  const shownIds = useMemo(() => shown.map((thread) => thread.id), [shown]);

  // A comment that left the list (resolved, sent elsewhere, filtered out) leaves the selection.
  useEffect(() => setSelected((current) => pruneSelection(current, shownIds)), [shownIds]);

  const groups = useMemo(() => {
    const byPath = new Map<string, CommentListEntry[]>();
    for (const thread of shown) {
      const path = commentCombPath(thread.path);
      byPath.set(path, [...(byPath.get(path) ?? []), thread]);
    }
    return [...byPath].sort(([a], [b]) => a.localeCompare(b));
  }, [shown]);

  if (!supported || threads.length === 0) return null;

  const picked = shown.filter((thread) => selected.has(thread.id));
  const sendable = eligibleForBatch(picked, serviceUserId);
  const busy = bulk.progress !== null;

  const resolve = async (ids: string[]) => {
    const outcome = await bulk.run(ids, true);
    setSelected(new Set());
    const { done, failed } = outcome;
    const summary = bulkSummary("Resolved", done.length, failed.length);
    const firstError = failed[0]?.error;
    const description = firstError instanceof Error ? firstError.message : undefined;
    if (done.length === 0) {
      toast.error(summary, { description });
      return;
    }
    const show = failed.length > 0 ? toast.warning : toast.success;
    show(summary, {
      description,
      // Long enough to reach Undo after a big batch.
      duration: 10_000,
      action: {
        label: "Undo",
        onClick: () =>
          void bulk.run(done, false).then((undo) => {
            const text = bulkSummary("Reopened", undo.done.length, undo.failed.length);
            if (undo.failed.length > 0) toast.warning(text);
            else toast.success(text);
          }),
      },
    });
  };

  return (
    <section
      aria-label="Open comments"
      className="flex max-h-80 shrink-0 flex-col rounded-xl border border-border bg-card"
    >
      <header className="flex min-h-11 items-center gap-2 border-b border-border-subtle px-3 py-1.5">
        <Checkbox
          aria-label="Select all shown comments"
          checked={selectionState(selected, shownIds)}
          disabled={busy || shown.length === 0}
          onCheckedChange={(on) => setSelected((current) => setAll(current, shownIds, on === true))}
        />
        {bulk.progress ? (
          <p
            className="flex flex-1 items-center gap-2 text-sm text-muted-foreground"
            aria-live="polite"
          >
            <Spinner className="size-4" />
            Working on {bulk.progress.finished} of {bulk.progress.total}
          </p>
        ) : picked.length > 0 ? (
          <>
            <span className="flex-1 text-sm font-medium tabular-nums">
              {picked.length} selected
            </span>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  size="sm"
                  variant="outline"
                  aria-disabled={sendable.length === 0}
                  className="aria-disabled:opacity-50"
                  onClick={() => (sendable.length > 0 ? setSending(sendable) : undefined)}
                >
                  <Send />
                  <span className="hidden sm:inline">Send to swarm</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>
                {sendable.length > 0
                  ? "Send the checked comments to the lead as one task"
                  : "The checked comments were already sent"}
              </TooltipContent>
            </Tooltip>
            <Button size="sm" onClick={() => void resolve(picked.map((thread) => thread.id))}>
              <CheckCheck />
              Resolve
            </Button>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label="Clear selection"
              onClick={() => setSelected(new Set())}
            >
              <X />
            </Button>
          </>
        ) : (
          <>
            <h2 className="flex flex-1 items-center gap-2 text-sm font-medium">
              <MessageSquare className="size-4 text-muted-foreground" aria-hidden />
              Open comments
              <span className="text-muted-foreground tabular-nums">
                {age === "any" ? threads.length : `${shown.length} of ${threads.length}`}
              </span>
            </h2>
            <Select value={age} onValueChange={(value) => setAge(value as AgeFilter)}>
              <SelectTrigger size="sm" aria-label="Comment age" className="text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end">
                {AGE_FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </>
        )}
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {query.data?.truncated ? (
          <p className="px-3 pt-2 text-xs text-muted-foreground">
            Showing the newest {threads.length.toLocaleString()} comments.
          </p>
        ) : null}
        {shown.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            No open comments {AGE_FILTERS.find((item) => item.value === age)?.label.toLowerCase()}.
          </p>
        ) : null}
        {groups.map(([path, fileThreads]) => {
          const ids = fileThreads.map((thread) => thread.id);
          const name = path.slice(folder.path.length) || path;
          return (
            <div key={path} className="border-b border-border-subtle px-3 py-2 last:border-b-0">
              <div className="flex min-w-0 items-center gap-2">
                <Checkbox
                  aria-label={`Select the comments on ${name}`}
                  checked={selectionState(selected, ids)}
                  disabled={busy}
                  onCheckedChange={(on) =>
                    setSelected((current) => setAll(current, ids, on === true))
                  }
                />
                <Link
                  to={combPath({ ...folder, path })}
                  className="min-w-0 truncate rounded-sm font-mono text-xs text-muted-foreground underline-offset-2 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {name}
                </Link>
              </div>
              <ul className="mt-1 flex flex-col">
                {fileThreads.map((thread) => {
                  const author = thread.authorDisplayName || authorLabel(thread.author);
                  return (
                    <li key={thread.id} className="flex min-w-0 items-center gap-2">
                      <Checkbox
                        aria-label={`Select the comment by ${author}`}
                        checked={selected.has(thread.id)}
                        disabled={busy}
                        onCheckedChange={(on) =>
                          setSelected((current) => setAll(current, [thread.id], on === true))
                        }
                      />
                      <Link
                        to={`${combPath({ ...folder, path })}?comment=${encodeURIComponent(thread.id)}`}
                        className="hover-linger flex min-w-0 flex-1 items-baseline gap-2 rounded-md px-1.5 py-1 text-sm outline-none transition-colors hover:bg-accent/50 focus-visible:bg-accent/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
                      >
                        <span className="max-w-[40%] shrink-0 truncate text-xs font-medium">
                          {author}
                        </span>
                        <span className="min-w-0 flex-1 truncate">{thread.body}</span>
                        <FolderThreadState
                          state={states.get(thread.id)}
                          sent={isSentToSwarm(thread, serviceUserId)}
                        />
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })}
      </div>
      {sending ? (
        <SendBatchDialog
          drive={folder}
          scopePath={folder.path}
          threads={sending}
          showPaths
          onSent={() => setSelected(new Set())}
          onClose={() => setSending(null)}
        />
      ) : null}
    </section>
  );
}

/** "Processing", else "Sent" for a thread the swarm got (and answered or finished). */
function FolderThreadState({
  state,
  sent,
}: {
  state: ThreadSwarmState | undefined;
  sent: boolean;
}) {
  if (state?.kind === "processing") return <SwarmStateTag state={state} />;
  if (!sent) return null;
  return <span className="shrink-0 text-xs text-muted-foreground">Sent</span>;
}
