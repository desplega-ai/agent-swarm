/**
 * Jira inbound sync handlers.
 *
 * Mirrors the Linear sync blueprint at `src/linear/sync.ts`, adapted for
 * Jira's event payload shapes and ADF rich-text fields. Three entry points:
 *
 *   - `handleIssueEvent`         — `jira:issue_updated` (assignee changes)
 *   - `handleCommentEvent`       — `comment_created` / `comment_updated`
 *   - `handleIssueDeleteEvent`   — `jira:issue_deleted`
 *
 * Atomicity contract: tracker_sync row is inserted FIRST (via UNIQUE-gated
 * `createTrackerSyncIfAbsent`), then the swarm task is created only when the
 * insert was new. A crash between the two leaves an orphan sync row with
 * `swarmId = ""` — reconcilable on retry.
 */

import { cancelTask, getAllAgents, getTaskById } from "../be/db";
import { getOAuthTokens } from "../be/db-queries/oauth";
import {
  createTrackerSyncIfAbsent,
  getTrackerSyncByExternalId,
  updateTrackerSyncSwarmId,
} from "../be/db-queries/tracker";
import { ensureToken } from "../oauth/ensure-token";
import { resolveTemplate } from "../prompts/resolver";
import { buildJiraContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import type { Agent } from "../types";
import { extractMentions, extractText } from "./adf";
import { getJiraMetadata } from "./metadata";
// Side-effect import: registers all Jira event templates in the prompt registry
import "./templates";

// ─── Bot identity (Atlassian accountId) ────────────────────────────────────

// Cache the bot's Atlassian accountId on globalThis (not a module-level `let`)
// so that test runners which re-import the module under cache-busting URLs —
// e.g. the templates `?t=${Date.now()}` pattern in src/tests/jira-sync.test.ts —
// still observe the same cache slot. Without this, CI's parallel test order can
// land a new module copy whose `cachedBotAccountId` is `null` while the test's
// seeded value sits on the original copy, causing handler short-circuits.
const BOT_ACCOUNT_ID_SLOT = Symbol.for("agent-swarm.jira.botAccountId");
type BotIdHolder = { [BOT_ACCOUNT_ID_SLOT]?: string | null };

function getCachedBotAccountId(): string | null {
  return (globalThis as BotIdHolder)[BOT_ACCOUNT_ID_SLOT] ?? null;
}

function setCachedBotAccountId(value: string | null): void {
  (globalThis as BotIdHolder)[BOT_ACCOUNT_ID_SLOT] = value;
}

/**
 * Resolve and cache the bot Atlassian `accountId` via the User Identity API
 * `https://api.atlassian.com/me`.
 *
 * We deliberately avoid `/rest/api/3/myself` because that endpoint requires
 * `read:jira-user` (not in our Phase 0 scope set). `/me` returns the same
 * Atlassian `account_id` (atlassian-wide identifier — issue assignees and
 * comment authors are keyed on the same value) and is covered by `read:me`,
 * which we already have.
 *
 * The first webhook delivery after a fresh boot pays the round-trip cost; all
 * subsequent calls hit the in-memory cache. `resetBotAccountIdCache()` clears
 * it on `resetJira()` so a reconnect as a different Atlassian user picks up
 * the new identity.
 *
 * Returns `null` (not throws) when Jira is not connected — the inbound
 * handlers prefer to return 200 + log a warning over surfacing 500s that
 * would trigger Atlassian retries.
 */
export async function resolveBotAccountId(): Promise<string | null> {
  const cached = getCachedBotAccountId();
  if (cached) return cached;

  try {
    await ensureToken("jira");
    const tokens = getOAuthTokens("jira");
    if (!tokens?.accessToken) {
      console.warn("[Jira Sync] No Jira access token; cannot resolve bot accountId");
      return null;
    }
    const res = await fetch("https://api.atlassian.com/me", {
      headers: {
        Authorization: `Bearer ${tokens.accessToken}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      console.warn(`[Jira Sync] /me returned ${res.status}; cannot resolve bot accountId`);
      return null;
    }
    const data = (await res.json()) as { account_id?: unknown };
    if (typeof data.account_id !== "string" || data.account_id.length === 0) {
      console.warn("[Jira Sync] /me response missing account_id");
      return null;
    }
    setCachedBotAccountId(data.account_id);
    return data.account_id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[Jira Sync] Failed to resolve bot accountId: ${message}`);
    return null;
  }
}

/** Test-visible cache reset; called from `resetJira()`. */
export function resetBotAccountIdCache(): void {
  setCachedBotAccountId(null);
}

/** Test-only: seed the cache so handler tests can run without an OAuth round-trip. */
export function _setBotAccountIdForTesting(id: string | null): void {
  setCachedBotAccountId(id);
}

// ─── Lead-agent picker (mirrors Linear) ────────────────────────────────────

function findLeadAgent(): Agent | null {
  const agents = getAllAgents();
  const onlineLead = agents.find((a) => a.isLead && a.status !== "offline");
  if (onlineLead) return onlineLead;
  return agents.find((a) => a.isLead) ?? null;
}

// ─── URL helpers ───────────────────────────────────────────────────────────

function buildIssueUrl(issueKey: string): string {
  const meta = getJiraMetadata();
  const siteUrl = (meta.siteUrl ?? "").replace(/\/+$/, "");
  if (!siteUrl) return "";
  return `${siteUrl}/browse/${issueKey}`;
}

// ─── Outbound-echo skip window (mirrors Linear's 5s) ────────────────────────

const OUTBOUND_ECHO_WINDOW_MS = 5_000;

function isWithinOutboundEchoWindow(lastSyncedAt: string | null | undefined): boolean {
  if (!lastSyncedAt) return false;
  const ts = new Date(lastSyncedAt).getTime();
  if (Number.isNaN(ts)) return false;
  return Date.now() - ts < OUTBOUND_ECHO_WINDOW_MS;
}

// ─── Issue events (assignee transitions) ───────────────────────────────────

type ChangelogItem = {
  field?: string;
  fieldId?: string;
  from?: string | null;
  to?: string | null;
};

type IssueShape = {
  id?: string;
  key?: string;
  fields?: {
    summary?: string;
    description?: unknown;
    reporter?: { displayName?: string; accountId?: string } | null;
  };
};

/**
 * Handle `jira:issue_updated` events. We only care about assignee transitions
 * **to** the bot account (transitions away from the bot are ignored).
 *
 * Routing:
 *   - No prior sync row  → create swarm task with `jira.issue.assigned`
 *   - Prior task active  → log + ignore (Linear pattern: keep the existing
 *     in-flight task; reassignment just means "still ours")
 *   - Prior task done    → create follow-up via `jira.issue.followup`
 */
export async function handleIssueEvent(event: Record<string, unknown>): Promise<void> {
  const issue = event.issue as IssueShape | undefined;
  if (!issue?.id || !issue.key) {
    console.log("[Jira Sync] issue_updated: missing issue.id/key — skipping");
    return;
  }

  const changelog = event.changelog as { items?: ChangelogItem[] } | undefined;
  const items = Array.isArray(changelog?.items) ? changelog.items : [];

  const botAccountId = await resolveBotAccountId();
  if (!botAccountId) {
    console.warn(
      "[Jira Sync] Webhook received but bot accountId is unresolved (Jira not connected?) — ignoring",
    );
    return;
  }

  // Direction filter: only handle transitions TO the bot, not FROM.
  const transitionedToBot = items.some(
    (it) =>
      (it.field === "assignee" || it.fieldId === "assignee") &&
      it.to === botAccountId &&
      it.from !== botAccountId,
  );

  if (!transitionedToBot) {
    return;
  }

  const issueId = issue.id;
  const issueKey = issue.key;
  const summary = issue.fields?.summary ?? "(no summary)";
  const reporterName = issue.fields?.reporter?.displayName ?? "";
  const descriptionText = extractText(issue.fields?.description);
  const issueUrl = buildIssueUrl(issueKey);

  // Step 1: claim the sync row UNIQUE-gated. Pass empty swarmId placeholder;
  // we update it once the task is created.
  const claim = createTrackerSyncIfAbsent({
    provider: "jira",
    entityType: "task",
    providerEntityType: "Issue",
    swarmId: "",
    externalId: issueId,
    externalIdentifier: issueKey,
    externalUrl: issueUrl,
    lastSyncOrigin: "external",
    syncDirection: "inbound",
  });

  if (claim.inserted) {
    // Fresh — create initial task
    await createInitialJiraTask({
      issueKey,
      summary,
      reporterName,
      descriptionText,
      issueUrl,
      syncRowId: claim.sync.id,
      followup: false,
    });
    return;
  }

  // Pre-existing — branch on prior task state.
  const priorTask = claim.sync.swarmId ? getTaskById(claim.sync.swarmId) : null;
  if (priorTask && !["completed", "failed", "cancelled"].includes(priorTask.status)) {
    // In-progress: do not duplicate. Match Linear's behavior of acknowledging
    // and continuing with the existing task.
    console.log(
      `[Jira Sync] Issue ${issueKey} re-assigned to bot but task ${priorTask.id} still ${priorTask.status} — ignoring`,
    );
    return;
  }

  // Terminal prior task (or orphan sync row with no swarmId) → follow-up.
  await createInitialJiraTask({
    issueKey,
    summary,
    reporterName,
    descriptionText,
    issueUrl,
    syncRowId: claim.sync.id,
    followup: true,
    followupTrigger: "Issue re-assigned to bot",
    followupMessage: "",
  });
}

// ─── Comment events (mention triggers) ─────────────────────────────────────

type CommentShape = {
  id?: string;
  body?: unknown;
  author?: { accountId?: string; displayName?: string } | null;
  updateAuthor?: { accountId?: string; displayName?: string } | null;
};

/**
 * Handle `comment_created` / `comment_updated` events.
 *
 * Three short-circuits before any work:
 *   1. Self-authored skip (we don't process our own comments)
 *   2. Outbound-echo skip (5s window after a swarm-posted comment)
 *   3. Mention check (is the bot @-mentioned in the body?)
 *
 * Routing on a hit:
 *   - No prior sync row    → create swarm task with `jira.issue.assigned`
 *   - Prior task active    → log + ignore
 *   - Prior task done      → follow-up via `jira.issue.followup`
 */
export async function handleCommentEvent(event: Record<string, unknown>): Promise<void> {
  const issue = event.issue as IssueShape | undefined;
  const comment = event.comment as CommentShape | undefined;

  if (!issue?.id || !issue.key) {
    console.log("[Jira Sync] comment event: missing issue.id/key — skipping");
    return;
  }
  if (!comment) {
    console.log("[Jira Sync] comment event: missing comment payload — skipping");
    return;
  }

  const botAccountId = await resolveBotAccountId();
  if (!botAccountId) {
    console.warn("[Jira Sync] Comment webhook received but bot accountId is unresolved — ignoring");
    return;
  }

  // 1. Self-authored skip.
  const authorId = comment.author?.accountId ?? comment.updateAuthor?.accountId ?? "";
  if (authorId === botAccountId) {
    return;
  }

  // 2. Outbound-echo skip (race window).
  const existing = getTrackerSyncByExternalId("jira", "task", issue.id);
  if (
    existing &&
    existing.lastSyncOrigin === "swarm" &&
    isWithinOutboundEchoWindow(existing.lastSyncedAt)
  ) {
    console.log(
      `[Jira Sync] Outbound-echo skip for issue ${issue.key} (within ${OUTBOUND_ECHO_WINDOW_MS}ms)`,
    );
    return;
  }

  // 3. Mention check.
  const mentionIds = extractMentions(comment.body);
  if (!mentionIds.includes(botAccountId)) {
    return;
  }

  const issueKey = issue.key;
  const summary = issue.fields?.summary ?? "(no summary)";
  const descriptionText = extractText(issue.fields?.description);
  const commentText = extractText(comment.body);
  const commentAuthor = comment.author?.displayName ?? "";
  const issueUrl = buildIssueUrl(issueKey);

  if (!existing) {
    // Comment-mention into existence.
    const claim = createTrackerSyncIfAbsent({
      provider: "jira",
      entityType: "task",
      providerEntityType: "Issue",
      swarmId: "",
      externalId: issue.id,
      externalIdentifier: issueKey,
      externalUrl: issueUrl,
      lastSyncOrigin: "external",
      syncDirection: "inbound",
    });

    // Race: another concurrent delivery may have just won the insert. Fall
    // through to the follow-up branch — we still want the user's mention
    // surfaced as either a fresh task or a follow-up, depending on prior
    // state.
    if (claim.inserted) {
      await createCommentMentionTask({
        issueKey,
        summary,
        descriptionText,
        commentText,
        commentAuthor,
        issueUrl,
        syncRowId: claim.sync.id,
      });
      return;
    }
    // Fall through with the now-existing row so we route via follow-up logic.
    return routeCommentOnExistingSync({
      issueKey,
      summary,
      issueUrl,
      commentText,
      commentAuthor,
      syncRow: claim.sync,
    });
  }

  await routeCommentOnExistingSync({
    issueKey,
    summary,
    issueUrl,
    commentText,
    commentAuthor,
    syncRow: existing,
  });
}

async function routeCommentOnExistingSync(input: {
  issueKey: string;
  summary: string;
  issueUrl: string;
  commentText: string;
  commentAuthor: string;
  syncRow: { id: string; swarmId: string };
}): Promise<void> {
  const priorTask = input.syncRow.swarmId ? getTaskById(input.syncRow.swarmId) : null;
  if (priorTask && !["completed", "failed", "cancelled"].includes(priorTask.status)) {
    // In-progress: log and ignore (mirrors Linear's prompted-on-active path).
    console.log(
      `[Jira Sync] Bot mentioned on issue ${input.issueKey} but task ${priorTask.id} still ${priorTask.status} — ignoring`,
    );
    return;
  }

  // Terminal or orphan sync row → follow-up.
  await createInitialJiraTask({
    issueKey: input.issueKey,
    summary: input.summary,
    reporterName: input.commentAuthor,
    descriptionText: "",
    issueUrl: input.issueUrl,
    syncRowId: input.syncRow.id,
    followup: true,
    followupTrigger: `New comment from ${input.commentAuthor || "user"}`,
    followupMessage: input.commentText,
  });
}

// ─── Issue delete events ───────────────────────────────────────────────────

export async function handleIssueDeleteEvent(event: Record<string, unknown>): Promise<void> {
  const issue = event.issue as IssueShape | undefined;
  if (!issue?.id) return;

  const sync = getTrackerSyncByExternalId("jira", "task", issue.id);
  if (!sync) return;

  const task = sync.swarmId ? getTaskById(sync.swarmId) : null;
  if (task && !["completed", "failed", "cancelled"].includes(task.status)) {
    cancelTask(sync.swarmId, "Jira issue deleted");
    console.log(
      `[Jira Sync] Cancelled task ${sync.swarmId} (Jira issue ${issue.key ?? issue.id} deleted)`,
    );
  }
}

// ─── Task creation helpers ─────────────────────────────────────────────────

async function createInitialJiraTask(input: {
  issueKey: string;
  summary: string;
  reporterName: string;
  descriptionText: string;
  issueUrl: string;
  syncRowId: string;
  followup: boolean;
  followupTrigger?: string;
  followupMessage?: string;
}): Promise<void> {
  const lead = findLeadAgent();
  const descriptionSection = input.descriptionText
    ? `\nDescription:\n${input.descriptionText}\n`
    : "";

  const tmplName = input.followup ? "jira.issue.followup" : "jira.issue.assigned";
  const variables = input.followup
    ? {
        issue_key: input.issueKey,
        issue_summary: input.summary,
        issue_url: input.issueUrl,
        trigger: input.followupTrigger ?? "Re-engagement on tracked issue",
        user_message: input.followupMessage ?? "",
      }
    : {
        issue_key: input.issueKey,
        issue_summary: input.summary,
        issue_url: input.issueUrl,
        reporter: input.reporterName,
        description_section: descriptionSection,
      };

  const result = resolveTemplate(tmplName, variables);
  if (result.skipped) {
    console.log(`[Jira Sync] Template ${tmplName} resolved as skipped — not creating task`);
    return;
  }

  const task = createTaskWithSiblingAwareness(result.text, {
    agentId: lead?.id ?? "",
    source: "jira",
    taskType: "jira-issue",
    contextKey: buildJiraContextKey(input.issueKey),
  });

  updateTrackerSyncSwarmId(input.syncRowId, task.id);

  const action = input.followup ? "follow-up" : "new";
  console.log(
    `[Jira Sync] Created ${action} task ${task.id} for ${input.issueKey} -> ${lead?.name ?? "unassigned"}`,
  );
}

async function createCommentMentionTask(input: {
  issueKey: string;
  summary: string;
  descriptionText: string;
  commentText: string;
  commentAuthor: string;
  issueUrl: string;
  syncRowId: string;
}): Promise<void> {
  const lead = findLeadAgent();
  const descriptionSection = input.descriptionText
    ? `\nDescription:\n${input.descriptionText}\n`
    : "";

  const result = resolveTemplate("jira.issue.commented", {
    issue_key: input.issueKey,
    issue_summary: input.summary,
    issue_url: input.issueUrl,
    comment_author: input.commentAuthor,
    description_section: descriptionSection,
    comment_text: input.commentText,
  });

  if (result.skipped) {
    console.log("[Jira Sync] jira.issue.commented resolved as skipped — not creating task");
    return;
  }

  const task = createTaskWithSiblingAwareness(result.text, {
    agentId: lead?.id ?? "",
    source: "jira",
    taskType: "jira-issue",
    contextKey: buildJiraContextKey(input.issueKey),
  });

  updateTrackerSyncSwarmId(input.syncRowId, task.id);

  console.log(
    `[Jira Sync] Created comment-mention task ${task.id} for ${input.issueKey} -> ${lead?.name ?? "unassigned"}`,
  );
}
