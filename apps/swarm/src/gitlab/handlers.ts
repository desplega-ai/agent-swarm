/**
 * GitLab Webhook Event Handlers
 *
 * Mirrors the pattern from src/github/handlers.ts:
 * - Parses GitLab webhook payloads
 * - Creates agent tasks via createTaskExtended()
 * - Deduplicates events via in-memory TTL map
 * - Detects bot mentions
 */

import { failTask, findTaskByVcs, getAllAgents, incrKv, upsertKv } from "../be/db";
import { findOrCreateUserByEmail, findUserByExternalId, linkIdentity } from "../be/users";
import { resolveTemplate } from "../prompts/resolver";
import { gitlabContextKey } from "../tasks/context-key";
import { createTaskWithSiblingAwareness } from "../tasks/sibling-awareness";
import { GITLAB_BOT_NAME } from "./auth";
import { addGitLabNoteReaction, addGitLabReaction } from "./reactions";
import type { GitLabUser } from "./types";
// Side-effect import: registers all GitLab event templates in the in-memory registry
import "./templates";
import type { IssueEvent, MergeRequestEvent, NoteEvent, PipelineEvent } from "./types";

// ── Dedup cache (same pattern as GitHub) ──
const processedEvents = new Map<string, number>();
const DEDUP_TTL_MS = 60_000;

function isDuplicate(key: string): boolean {
  const now = Date.now();
  // Cleanup expired
  for (const [k, ts] of processedEvents) {
    if (now - ts > DEDUP_TTL_MS) processedEvents.delete(k);
  }
  if (processedEvents.has(key)) return true;
  processedEvents.set(key, now);
  return false;
}

// ── Helpers ──

function detectMention(text: string | null | undefined): boolean {
  if (!text) return false;
  return new RegExp(`@${GITLAB_BOT_NAME}\\b`, "i").test(text);
}

function extractMentionContext(text: string): string {
  return text.replace(new RegExp(`@${GITLAB_BOT_NAME}\\b`, "gi"), "").trim();
}

function findLeadAgent() {
  const agents = getAllAgents();
  return (
    agents.find((a) => a.role === "lead" && a.status === "idle") ??
    agents.find((a) => a.role === "lead") ??
    null
  );
}

// ── Identity resolution ──

const UNMAPPED_NAMESPACE = "integration:unmapped:gitlab";
const UNMAPPED_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const GITLAB_WEBHOOK_ACTOR = { kind: "system", id: "webhook:gitlab" } as const;

/**
 * Resolve a GitLab webhook sender to a `users.id`.
 *
 * Cascade (Q17):
 *   1. Fast path — `findUserByExternalId('gitlab', user.username)`.
 *   2. If missing AND `user.email` is a real non-empty string (some GitLab
 *      installations send `email: ""` instead of omitting the field — Q17.E
 *      manual spot-check), run `findOrCreateUserByEmail` + `linkIdentity`.
 *   3. Otherwise record an unmapped tracker entry (kv) for operator triage.
 *
 * Returns `undefined` when no mapping could be established — callers pass
 * that straight to `requestedByUserId`.
 */
function resolveGitLabSender(
  user: GitLabUser,
  sampleEventType: string,
  sampleContext: string,
): string | undefined {
  const existing = findUserByExternalId("gitlab", user.username);
  if (existing) return existing.id;

  // Inline-email cascade — only run when email is a real non-empty string.
  // Some GitLab installations emit `email: ""` instead of omitting the field.
  const inlineEmail = typeof user.email === "string" ? user.email.trim() : "";
  if (inlineEmail !== "") {
    const { user: linked } = findOrCreateUserByEmail(
      inlineEmail,
      { name: user.name },
      GITLAB_WEBHOOK_ACTOR,
    );
    linkIdentity(linked.id, "gitlab", user.username, GITLAB_WEBHOOK_ACTOR);
    return linked.id;
  }

  // No mapping + no inline email → unmapped tracker.
  upsertKv({
    namespace: UNMAPPED_NAMESPACE,
    key: `${user.username}:meta`,
    value: {
      lastSeenAt: new Date().toISOString(),
      sampleEventType,
      sampleContext: sampleContext.slice(0, 100),
    },
    valueType: "json",
    expiresAt: Date.now() + UNMAPPED_TTL_MS,
  });
  incrKv(UNMAPPED_NAMESPACE, `${user.username}:count`, 1);
  return undefined;
}

// ── Event Handlers ──

export async function handleMergeRequest(
  event: MergeRequestEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { user, project, object_attributes: mr } = event;
  const action = mr.action;
  const repo = project.path_with_namespace;

  // Resolve canonical user from GitLab sender
  const requestedByUserId = resolveGitLabSender(
    user,
    "merge_request",
    `MR !${mr.iid}: ${mr.title}`,
  );

  console.log(`[GitLab] MR #${mr.iid} ${action} by ${user.username} in ${repo}`);

  const dedupKey = `gitlab-mr-${repo}-${mr.iid}-${action}-${user.username}`;
  if (isDuplicate(dedupKey)) {
    console.log(`[GitLab] Skipping duplicate MR event`);
    return { created: false };
  }

  const lead = findLeadAgent();

  switch (action) {
    case "open": {
      // Check for bot mention in description
      const hasMention = detectMention(mr.description);
      if (!hasMention) {
        console.log(`[GitLab] MR opened without bot mention, skipping`);
        return { created: false };
      }

      const context = mr.description ? extractMentionContext(mr.description) : "";
      const contextSection = context ? `Context: ${context}\n\n` : "";
      const result = resolveTemplate("gitlab.merge_request.opened", {
        mr_iid: mr.iid,
        mr_title: mr.title,
        repo,
        username: user.username,
        source_branch: mr.source_branch,
        target_branch: mr.target_branch,
        mr_url: mr.url,
        context_section: contextSection,
      });

      if (result.skipped) {
        return { created: false };
      }

      const task = createTaskWithSiblingAwareness(result.text, {
        agentId: lead?.id ?? null,
        source: "gitlab",
        vcsProvider: "gitlab",
        taskType: "gitlab-mr",
        vcsRepo: repo,
        vcsEventType: "merge_request",
        vcsNumber: mr.iid,
        vcsAuthor: user.username,
        requestedByUserId,
        vcsUrl: mr.url,
        contextKey: gitlabContextKey({
          projectId: String(project.id),
          kind: "mr",
          iid: mr.iid,
        }),
      });

      try {
        await addGitLabReaction(repo, "mr", mr.iid, "eyes");
      } catch {}

      return { created: true, taskId: task.id };
    }

    case "close":
    case "merge": {
      // Cancel existing tasks for this MR
      const existingTask = findTaskByVcs(repo, mr.iid);
      if (existingTask) {
        const reason = action === "merge" ? "MR was merged" : "MR was closed";
        console.log(`[GitLab] Cancelling task ${existingTask.id} — ${reason}`);
        failTask(existingTask.id, reason);
      }
      return { created: false };
    }

    case "update": {
      // Check if there's an active task for this MR — if so, notify about the update
      const task = findTaskByVcs(repo, mr.iid);
      if (task) {
        console.log(`[GitLab] MR #${mr.iid} updated, active task exists: ${task.id}`);
        // Don't create a new task — the worker will see the changes
        return { created: false };
      }
      return { created: false };
    }

    default:
      console.log(`[GitLab] Ignoring MR action: ${action}`);
      return { created: false };
  }
}

export async function handleIssue(
  event: IssueEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { user, project, object_attributes: issue } = event;
  const action = issue.action;
  const repo = project.path_with_namespace;

  // Resolve canonical user from GitLab sender
  const requestedByUserId = resolveGitLabSender(
    user,
    "issue",
    `Issue #${issue.iid}: ${issue.title}`,
  );

  console.log(`[GitLab] Issue #${issue.iid} ${action} by ${user.username} in ${repo}`);

  const dedupKey = `gitlab-issue-${repo}-${issue.iid}-${action}-${user.username}`;
  if (isDuplicate(dedupKey)) {
    return { created: false };
  }

  const lead = findLeadAgent();

  switch (action) {
    case "open": {
      const hasMention = detectMention(issue.description);
      if (!hasMention) {
        // Check if bot is in assignees
        const isBotAssigned = event.assignees?.some(
          (a) => a.username.toLowerCase() === GITLAB_BOT_NAME.toLowerCase(),
        );
        if (!isBotAssigned) {
          console.log(`[GitLab] Issue opened without bot mention/assignment, skipping`);
          return { created: false };
        }
      }

      const context = issue.description ? extractMentionContext(issue.description) : "";
      const contextSection = context ? `Context: ${context}\n\n` : "";
      const result = resolveTemplate("gitlab.issue.assigned", {
        issue_iid: issue.iid,
        issue_title: issue.title,
        repo,
        username: user.username,
        issue_url: issue.url,
        context_section: contextSection,
      });

      if (result.skipped) {
        return { created: false };
      }

      const task = createTaskWithSiblingAwareness(result.text, {
        agentId: lead?.id ?? null,
        source: "gitlab",
        vcsProvider: "gitlab",
        taskType: "gitlab-issue",
        vcsRepo: repo,
        vcsEventType: "issue",
        vcsNumber: issue.iid,
        vcsAuthor: user.username,
        requestedByUserId,
        vcsUrl: issue.url,
        contextKey: gitlabContextKey({
          projectId: String(project.id),
          kind: "issue",
          iid: issue.iid,
        }),
      });

      try {
        await addGitLabReaction(repo, "issue", issue.iid, "eyes");
      } catch {}

      return { created: true, taskId: task.id };
    }

    case "close": {
      const existingTask = findTaskByVcs(repo, issue.iid);
      if (existingTask) {
        console.log(`[GitLab] Cancelling task ${existingTask.id} — issue closed`);
        failTask(existingTask.id, "Issue was closed");
      }
      return { created: false };
    }

    default:
      return { created: false };
  }
}

export async function handleNote(event: NoteEvent): Promise<{ created: boolean; taskId?: string }> {
  const { user, project, object_attributes: note } = event;
  const repo = project.path_with_namespace;

  // Resolve canonical user from GitLab sender — currently dead-coded
  // (underscore prefix). Rewired for parity with live sites; if a future
  // change uses the value, the resolution path is already correct.
  const _requestedByUserId = resolveGitLabSender(user, "note", note.note);

  // Only handle comments with bot mentions
  if (!detectMention(note.note)) {
    return { created: false };
  }

  console.log(`[GitLab] Note by ${user.username} in ${repo} (${note.noteable_type})`);

  const dedupKey = `gitlab-note-${note.id}`;
  if (isDuplicate(dedupKey)) {
    return { created: false };
  }

  const lead = findLeadAgent();
  const context = extractMentionContext(note.note);

  // Determine the target entity (MR or issue)
  let targetNumber: number | undefined;
  let targetUrl: string;
  let eventType: string;
  let entityLabel: string;

  if (note.noteable_type === "MergeRequest" && event.merge_request) {
    targetNumber = event.merge_request.iid;
    targetUrl = event.merge_request.url ?? note.url;
    eventType = "note_on_mr";
    entityLabel = `MR #${targetNumber}`;
  } else if (note.noteable_type === "Issue" && event.issue) {
    targetNumber = event.issue.iid;
    targetUrl = event.issue.url ?? note.url;
    eventType = "note_on_issue";
    entityLabel = `Issue #${targetNumber}`;
  } else {
    console.log(`[GitLab] Ignoring note on ${note.noteable_type}`);
    return { created: false };
  }

  // Check if there's already an active task for this entity
  const existingTask = targetNumber ? findTaskByVcs(repo, targetNumber) : null;

  const existingTaskNote = existingTask
    ? `\n\n_Note: There's an active task (${existingTask.id}) for this ${entityLabel}._`
    : "";

  const noteResult = resolveTemplate("gitlab.comment.mentioned", {
    entity_label: entityLabel,
    username: user.username,
    repo,
    target_url: targetUrl,
    context,
    existing_task_note: existingTaskNote,
  });

  if (noteResult.skipped) {
    return { created: false };
  }

  const task = createTaskWithSiblingAwareness(noteResult.text, {
    agentId: lead?.id ?? null,
    source: "gitlab",
    vcsProvider: "gitlab",
    taskType: "gitlab-comment",
    vcsRepo: repo,
    vcsEventType: eventType,
    vcsNumber: targetNumber,
    vcsCommentId: note.id,
    vcsAuthor: user.username,
    vcsUrl: targetUrl,
    parentTaskId: existingTask?.id,
    contextKey: targetNumber
      ? gitlabContextKey({
          projectId: String(project.id),
          kind: note.noteable_type === "MergeRequest" ? "mr" : "issue",
          iid: targetNumber,
        })
      : undefined,
  });

  try {
    await addGitLabNoteReaction(
      repo,
      note.noteable_type === "MergeRequest" ? "mr" : "issue",
      targetNumber!,
      note.id,
      "eyes",
    );
  } catch {}

  return { created: true, taskId: task.id };
}

export async function handlePipeline(
  event: PipelineEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { project, object_attributes: pipeline } = event;
  const repo = project.path_with_namespace;

  // Only handle failed pipelines that are associated with a merge request
  if (pipeline.status !== "failed") {
    return { created: false };
  }

  if (!event.merge_request) {
    console.log(`[GitLab] Pipeline failed but no associated MR, skipping`);
    return { created: false };
  }

  const mrIid = event.merge_request.iid;
  const dedupKey = `gitlab-pipeline-${pipeline.id}`;
  if (isDuplicate(dedupKey)) {
    return { created: false };
  }

  // Only create task if there's already an active task for this MR
  const existingTask = findTaskByVcs(repo, mrIid);
  if (!existingTask) {
    return { created: false };
  }

  const lead = findLeadAgent();
  const pipelineResult = resolveTemplate("gitlab.pipeline.failed", {
    pipeline_id: pipeline.id,
    mr_iid: mrIid,
    repo,
    mr_title: event.merge_request.title,
    mr_url: event.merge_request.url,
    source_branch: event.merge_request.source_branch,
  });

  if (pipelineResult.skipped) {
    return { created: false };
  }

  const task = createTaskWithSiblingAwareness(pipelineResult.text, {
    agentId: lead?.id ?? null,
    source: "gitlab",
    vcsProvider: "gitlab",
    taskType: "gitlab-ci",
    vcsRepo: repo,
    vcsEventType: "pipeline",
    vcsNumber: mrIid,
    vcsAuthor: "",
    vcsUrl: event.merge_request.url,
    parentTaskId: existingTask.id,
    contextKey: gitlabContextKey({
      projectId: String(project.id),
      kind: "mr",
      iid: mrIid,
    }),
  });

  return { created: true, taskId: task.id };
}
