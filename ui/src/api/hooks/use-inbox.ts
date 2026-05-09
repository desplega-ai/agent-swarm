/**
 * Per-bucket data hooks for the dashboard action-items inbox (Phase 6
 * ≥1.76.0). Each hook joins a single source-data query against the user's
 * inbox-state rows so dismissed/snoozed/done items are filtered out
 * client-side.
 *
 * Polling budget per dashboard tick (5s): one call per source query (approval
 * requests, credential-missing agents, failed/cancelled tasks, recent
 * sessions) plus one cached call to `useTaskTemplates` (`staleTime: Infinity`)
 * and one to `useInboxState`. Sessions is shared with the `/sessions` sidebar
 * so the dashboard side incurs zero additional fetches when both surfaces are
 * mounted.
 */

import { useMemo } from "react";
import { useCurrentUser } from "@/contexts/current-user-context";
import type {
  AgentTask,
  ApprovalRequest,
  CredentialMissingAgent,
  InboxItemState,
  InboxItemType,
  SessionListItem,
  TaskTemplate,
} from "../types";
import { useApprovalRequests } from "./use-approval-requests";
import { useCredentialMissingAgents } from "./use-credential-missing-agents";
import { useInboxState } from "./use-inbox-state";
import { useSessions } from "./use-sessions";
import { useTaskTemplates } from "./use-task-templates";
import { useTasks } from "./use-tasks";

// ─── Filtering helpers ───────────────────────────────────────────────────────

/**
 * Build a Set keyed by `itemType:itemId` for inbox-state rows that should
 * cause an item to disappear from the inbox. Snoozed items only hide while
 * `snoozeUntil` is in the future — once it passes, they reappear as `open`.
 */
function buildHiddenSet(rows: InboxItemState[] | undefined, now: number): Set<string> {
  const hidden = new Set<string>();
  if (!rows) return hidden;
  for (const row of rows) {
    const key = `${row.itemType}:${row.itemId}`;
    if (row.status === "dismissed" || row.status === "done") {
      hidden.add(key);
      continue;
    }
    if (row.status === "snoozed") {
      const until = row.snoozeUntil ? Date.parse(row.snoozeUntil) : 0;
      if (Number.isFinite(until) && until > now) hidden.add(key);
    }
  }
  return hidden;
}

function isHidden(hidden: Set<string>, itemType: InboxItemType, itemId: string): boolean {
  return hidden.has(`${itemType}:${itemId}`);
}

// ─── Bucket: Blocking (approvals + credential-missing agents) ────────────────

export interface BlockingInboxItem {
  /** Synthetic key — `${kind}:${id}`. */
  key: string;
  kind: "approval" | "credential_missing";
  itemType: InboxItemType;
  itemId: string;
  title: string;
  subtitle: string;
  /** Source object for the deep link. */
  approval?: ApprovalRequest;
  agent?: CredentialMissingAgent;
}

export interface BlockingInboxResult {
  items: BlockingInboxItem[];
  approvalsCount: number;
  credentialsCount: number;
  isLoading: boolean;
}

export function useBlockingInbox(): BlockingInboxResult {
  const { userId } = useCurrentUser();
  const approvalsQ = useApprovalRequests({ status: "pending" });
  const credsQ = useCredentialMissingAgents();
  const stateQ = useInboxState({ userId });
  const now = Date.now();

  const items = useMemo<BlockingInboxItem[]>(() => {
    const hidden = buildHiddenSet(stateQ.data, now);
    const out: BlockingInboxItem[] = [];

    for (const a of approvalsQ.data ?? []) {
      if (isHidden(hidden, "approval", a.id)) continue;
      out.push({
        key: `approval:${a.id}`,
        kind: "approval",
        itemType: "approval",
        itemId: a.id,
        title: a.title || "Approval requested",
        subtitle: `${a.questions?.length ?? 0} question${(a.questions?.length ?? 0) === 1 ? "" : "s"} · ${a.workflowRunId ? "workflow" : "task"}`,
        approval: a,
      });
    }

    for (const agent of credsQ.data ?? []) {
      if (isHidden(hidden, "credential_missing", agent.agentId)) continue;
      // Prefer richer per-harness `credStatus.missing` (migration 055) when
      // present; fall back to top-level `missing[]` for older workers.
      const missing =
        agent.credStatus?.missing && agent.credStatus.missing.length > 0
          ? agent.credStatus.missing
          : agent.missing;
      const subtitle = missing.length
        ? `Missing: ${missing.slice(0, 3).join(", ")}${missing.length > 3 ? `, +${missing.length - 3}` : ""}`
        : "Waiting for credentials";
      out.push({
        key: `credential_missing:${agent.agentId}`,
        kind: "credential_missing",
        itemType: "credential_missing",
        itemId: agent.agentId,
        title: agent.name || "Agent waiting for credentials",
        subtitle,
        agent,
      });
    }

    return out;
  }, [approvalsQ.data, credsQ.data, stateQ.data, now]);

  return {
    items,
    approvalsCount: approvalsQ.data?.length ?? 0,
    credentialsCount: credsQ.data?.length ?? 0,
    isLoading: approvalsQ.isLoading || credsQ.isLoading || (Boolean(userId) && stateQ.isLoading),
  };
}

// ─── Bucket: Broken (failed/cancelled tasks last 7d) ─────────────────────────

export interface BrokenInboxItem {
  key: string;
  itemType: InboxItemType;
  itemId: string;
  title: string;
  subtitle: string;
  task: AgentTask;
}

export interface BrokenInboxResult {
  items: BrokenInboxItem[];
  isLoading: boolean;
}

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export function useBrokenInbox(): BrokenInboxResult {
  const { userId } = useCurrentUser();
  // Phase 2 multi-status CSV: one call instead of two. `createdAfter` is
  // server-side filtering on `agent_tasks.createdAt >= value`. `source: ["ui"]`
  // restricts to human-initiated chat tasks — Lead-spawned subtasks (source=mcp)
  // and other channels stay out of this dashboard bucket.
  const sevenDaysAgo = useMemo(() => new Date(Date.now() - SEVEN_DAYS_MS).toISOString(), []);
  const tasksQ = useTasks({
    status: "failed,cancelled",
    createdAfter: sevenDaysAgo,
    source: ["ui"],
    limit: 100,
  });
  const stateQ = useInboxState({ userId });
  const now = Date.now();

  const items = useMemo<BrokenInboxItem[]>(() => {
    const hidden = buildHiddenSet(stateQ.data, now);
    const tasks = tasksQ.data?.tasks ?? [];
    const out: BrokenInboxItem[] = [];
    for (const t of tasks) {
      if (isHidden(hidden, "broken_task", t.id)) continue;
      out.push({
        key: `broken_task:${t.id}`,
        itemType: "broken_task",
        itemId: t.id,
        title: t.task.length > 80 ? `${t.task.slice(0, 80)}…` : t.task,
        subtitle: t.failureReason?.length
          ? t.failureReason.length > 100
            ? `${t.failureReason.slice(0, 100)}…`
            : t.failureReason
          : t.status === "cancelled"
            ? "Cancelled"
            : "Failed",
        task: t,
      });
    }
    return out;
  }, [tasksQ.data, stateQ.data, now]);

  return {
    items,
    isLoading: tasksQ.isLoading || (Boolean(userId) && stateQ.isLoading),
  };
}

// ─── Bucket: To-read (recently completed root sessions) ─────────────────────

export interface ToReadInboxItem {
  key: string;
  itemType: InboxItemType;
  itemId: string;
  title: string;
  subtitle: string;
  session: SessionListItem;
}

export interface ToReadInboxResult {
  items: ToReadInboxItem[];
  isLoading: boolean;
}

export function useToReadInbox(): ToReadInboxResult {
  const { userId } = useCurrentUser();
  // `source: ["ui"]` matches the `/sessions` sidebar default — only
  // human-initiated chat sessions show up in this bucket.
  const sessionsQ = useSessions({ limit: 50, source: ["ui"] });
  const stateQ = useInboxState({ userId });
  const now = Date.now();

  const items = useMemo<ToReadInboxItem[]>(() => {
    const hidden = buildHiddenSet(stateQ.data, now);
    const sessions = sessionsQ.data ?? [];
    const cutoff = now - SEVEN_DAYS_MS;
    const out: ToReadInboxItem[] = [];
    for (const s of sessions) {
      if (s.latestStatus !== "completed") continue;
      const lastActivity = Date.parse(s.lastActivityAt);
      if (!Number.isFinite(lastActivity) || lastActivity < cutoff) continue;
      const id = s.root.id;
      if (isHidden(hidden, "to_read", id)) continue;
      const prompt = s.root.task ?? "";
      out.push({
        key: `to_read:${id}`,
        itemType: "to_read",
        itemId: id,
        title: prompt.length > 80 ? `${prompt.slice(0, 80)}…` : prompt || "Session",
        subtitle: `${s.chainTaskCount} task${s.chainTaskCount === 1 ? "" : "s"} · completed`,
        session: s,
      });
    }
    return out;
  }, [sessionsQ.data, stateQ.data, now]);

  return {
    items,
    isLoading: sessionsQ.isLoading || (Boolean(userId) && stateQ.isLoading),
  };
}

// ─── Bucket: To-start (task templates) ───────────────────────────────────────

export interface ToStartInboxItem {
  key: string;
  itemType: InboxItemType;
  itemId: string;
  title: string;
  subtitle: string;
  template: TaskTemplate;
}

export interface ToStartInboxResult {
  items: ToStartInboxItem[];
  isLoading: boolean;
}

export function useToStartInbox(): ToStartInboxResult {
  const { userId } = useCurrentUser();
  // v1 always asks for kind="task" — the registry is read-only / seed-only.
  const templatesQ = useTaskTemplates({ kind: "task" });
  const stateQ = useInboxState({ userId });
  const now = Date.now();

  const items = useMemo<ToStartInboxItem[]>(() => {
    const hidden = buildHiddenSet(stateQ.data, now);
    const out: ToStartInboxItem[] = [];
    for (const t of templatesQ.data ?? []) {
      if (isHidden(hidden, "to_start_template", t.id)) continue;
      out.push({
        key: `to_start_template:${t.id}`,
        itemType: "to_start_template",
        itemId: t.id,
        title: t.title,
        subtitle:
          t.description && t.description.length > 0
            ? t.description.length > 100
              ? `${t.description.slice(0, 100)}…`
              : t.description
            : t.category || "",
        template: t,
      });
    }
    return out;
  }, [templatesQ.data, stateQ.data, now]);

  return {
    items,
    isLoading: templatesQ.isLoading || (Boolean(userId) && stateQ.isLoading),
  };
}
