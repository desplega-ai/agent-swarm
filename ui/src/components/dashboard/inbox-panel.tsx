/**
 * Action-items inbox panel (Phase 6 ≥1.76.0).
 *
 * Mounts in the dashboard's `data-dashboard-inbox-slot` slot (see
 * `pages/dashboard/page.tsx`'s `<NewDashboard />`). Four buckets:
 *   - Blocking            (pending approvals + agents waiting_for_credentials)
 *   - Broken              (failed/cancelled tasks last 7d)
 *   - To read             (recently completed root sessions, last 7d)
 *   - To start            (rows from `task_templates`)
 *
 * Each card supports Dismiss / Snooze (1h / 4h / 1d) / Done. Body click goes
 * to a contextual deep link, except for the "To start" bucket where it
 * navigates to `/tasks?new=true&prefill=<template_id>` so the existing
 * `CreateTaskDialog` (which lives inside `TasksPage`) opens with the
 * template's prompt + tags pre-filled. We chose this query-param wiring over
 * extracting/sharing the dialog component directly because the dialog is
 * tightly coupled to `TasksPage`'s `useCreateTask` flow + dependency picker
 * (it queries `useTasks({ status: "pending", limit: 200 })` etc.); refactoring
 * it into a reusable controlled component would have been disproportionate.
 */

import { AlertCircle, AlertTriangle, BookOpen, FilePlus, Inbox } from "lucide-react";
import type { ComponentType } from "react";
import { useNavigate } from "react-router-dom";
import {
  type BlockingInboxItem,
  type BrokenInboxItem,
  type ToReadInboxItem,
  type ToStartInboxItem,
  useBlockingInbox,
  useBrokenInbox,
  useToReadInbox,
  useToStartInbox,
} from "@/api/hooks/use-inbox";
import { useUpdateInboxItem } from "@/api/hooks/use-inbox-state";
import type { InboxItemType } from "@/api/types";
import { Badge } from "@/components/ui/badge";
import { useCurrentUser } from "@/contexts/current-user-context";
import { cn } from "@/lib/utils";
import { InboxCard } from "./inbox-card";

interface BucketDef<T extends { key: string; itemType: InboxItemType; itemId: string }> {
  id: "blocking" | "broken" | "to-read" | "to-start";
  title: string;
  icon: ComponentType<{ className?: string }>;
  /** Status-token-driven tone — e.g. `border-status-warning/40` for blocking. */
  toneClass: string;
  emptyText: string;
  items: T[];
  isLoading: boolean;
  /** What activate-click does for an item. */
  activate: (item: T) => void;
  /** Optional per-card tone override (used by Blocking to color credential
   *  vs approval items differently). */
  cardTone?: (item: T) => string | undefined;
}

export function InboxPanel({ className }: { className?: string }) {
  const navigate = useNavigate();
  const { userId } = useCurrentUser();
  const blocking = useBlockingInbox();
  const broken = useBrokenInbox();
  const toRead = useToReadInbox();
  const toStart = useToStartInbox();
  const updateItem = useUpdateInboxItem();

  const dispatch = (
    itemType: InboxItemType,
    itemId: string,
    action: "dismiss" | "done" | "snooze",
    snoozeMs?: number,
  ) => {
    if (!userId) return;
    if (action === "dismiss") {
      updateItem.mutate({ userId, itemType, itemId, status: "dismissed" });
    } else if (action === "done") {
      updateItem.mutate({ userId, itemType, itemId, status: "done" });
    } else if (action === "snooze" && snoozeMs) {
      updateItem.mutate({
        userId,
        itemType,
        itemId,
        status: "snoozed",
        snoozeUntil: new Date(Date.now() + snoozeMs).toISOString(),
      });
    }
  };

  const blockingBucket: BucketDef<BlockingInboxItem> = {
    id: "blocking",
    title: "Blocking",
    icon: AlertCircle,
    toneClass: "border-status-error/40",
    emptyText: "Nothing blocked.",
    items: blocking.items,
    isLoading: blocking.isLoading,
    activate: (it) => {
      if (it.kind === "approval" && it.approval) {
        navigate(`/approval-requests/${it.approval.id}`);
      } else if (it.kind === "credential_missing" && it.agent) {
        navigate(`/agents/${it.agent.agentId}`);
      }
    },
    cardTone: (it) =>
      it.kind === "approval"
        ? "border-l-2 border-l-status-warning"
        : "border-l-2 border-l-status-error",
  };

  const brokenBucket: BucketDef<BrokenInboxItem> = {
    id: "broken",
    title: "Broken",
    icon: AlertTriangle,
    toneClass: "border-status-error/40",
    emptyText: "No failed tasks (last 7d).",
    items: broken.items,
    isLoading: broken.isLoading,
    activate: (it) => navigate(`/tasks/${it.task.id}`),
    cardTone: () => "border-l-2 border-l-status-error",
  };

  const toReadBucket: BucketDef<ToReadInboxItem> = {
    id: "to-read",
    title: "To read",
    icon: BookOpen,
    toneClass: "border-status-info/40",
    emptyText: "Nothing new to read.",
    items: toRead.items,
    isLoading: toRead.isLoading,
    activate: (it) => navigate(`/sessions/${it.session.root.id}`),
    cardTone: () => "border-l-2 border-l-status-info",
  };

  const toStartBucket: BucketDef<ToStartInboxItem> = {
    id: "to-start",
    title: "To start",
    icon: FilePlus,
    toneClass: "border-status-neutral/40",
    emptyText: "No starter templates.",
    items: toStart.items,
    isLoading: toStart.isLoading,
    activate: (it) => {
      // Per file header: navigate to `TasksPage` with prefill query params.
      // The existing `?new=true` wiring auto-opens the dialog.
      navigate(`/tasks?new=true&prefill=${encodeURIComponent(it.template.id)}`);
    },
    cardTone: () => "border-l-2 border-l-status-neutral",
  };

  return (
    <div className={cn("grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4", className)}>
      <BucketColumn
        bucket={blockingBucket}
        onAction={(item, action, ms) => dispatch(item.itemType, item.itemId, action, ms)}
      />
      <BucketColumn
        bucket={brokenBucket}
        onAction={(item, action, ms) => dispatch(item.itemType, item.itemId, action, ms)}
      />
      <BucketColumn
        bucket={toReadBucket}
        onAction={(item, action, ms) => dispatch(item.itemType, item.itemId, action, ms)}
      />
      <BucketColumn
        bucket={toStartBucket}
        onAction={(item, action, ms) => dispatch(item.itemType, item.itemId, action, ms)}
      />
    </div>
  );
}

function BucketColumn<
  T extends {
    key: string;
    itemType: InboxItemType;
    itemId: string;
    title: string;
    subtitle: string;
  },
>({
  bucket,
  onAction,
}: {
  bucket: BucketDef<T>;
  onAction: (item: T, action: "dismiss" | "done" | "snooze", ms?: number) => void;
}) {
  const Icon = bucket.icon;
  return (
    <section
      aria-labelledby={`inbox-bucket-${bucket.id}`}
      className={cn(
        "flex flex-col gap-2 rounded-lg border bg-card/50 p-3 min-h-0",
        bucket.toneClass,
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <h3
          id={`inbox-bucket-${bucket.id}`}
          className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          <Icon className="h-3.5 w-3.5" />
          {bucket.title}
        </h3>
        <Badge variant="outline" size="tag">
          {bucket.items.length}
        </Badge>
      </header>
      <div className="flex flex-col gap-1.5 max-h-[420px] overflow-y-auto pr-0.5">
        {bucket.items.length === 0 ? (
          <div className="flex items-center justify-center gap-1.5 rounded-md border border-dashed border-border px-3 py-4 text-[11px] text-muted-foreground">
            <Inbox className="h-3 w-3" />
            <span>{bucket.isLoading ? "Loading…" : bucket.emptyText}</span>
          </div>
        ) : (
          bucket.items.map((item) => (
            <InboxCard
              key={item.key}
              title={item.title}
              subtitle={item.subtitle}
              toneClass={bucket.cardTone?.(item)}
              onActivate={() => bucket.activate(item)}
              onDismiss={() => onAction(item, "dismiss")}
              onSnooze={(ms) => onAction(item, "snooze", ms)}
              onDone={() => onAction(item, "done")}
            />
          ))
        )}
      </div>
    </section>
  );
}
