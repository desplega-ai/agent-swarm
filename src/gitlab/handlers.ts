/**
 * GitLab Webhook Event Handlers
 *
 * Mirrors the pattern from src/github/handlers.ts:
 * - Parses GitLab webhook payloads
 * - Creates agent tasks via createTaskExtended()
 * - Deduplicates events via in-memory TTL map
 * - Detects bot mentions
 */

import { createTaskExtended, failTask, findTaskByVcs, getAllAgents } from "../be/db";
import { GITLAB_BOT_NAME } from "./auth";
import { addGitLabNoteReaction, addGitLabReaction } from "./reactions";
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

const DELEGATION_INSTRUCTION =
  "\n\n**Delegation instruction:** As the lead agent, analyze this and decide whether to handle it yourself or delegate to a worker agent. Use `send-task` to delegate with clear instructions.";

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

function getCommandSuggestions(type: string): string {
  switch (type) {
    case "mr":
      return "Suggested commands: `/review-pr` to review the MR, `/implement-issue` to implement changes.";
    case "issue":
      return "Suggested commands: `/implement-issue` to implement, `/close-issue` to close.";
    default:
      return "";
  }
}

// ── Event Handlers ──

export async function handleMergeRequest(
  event: MergeRequestEvent,
): Promise<{ created: boolean; taskId?: string }> {
  const { user, project, object_attributes: mr } = event;
  const action = mr.action;
  const repo = project.path_with_namespace;

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
      const taskDesc = `[GitLab MR #${mr.iid}] ${mr.title}\n\nRepo: ${repo}\nAuthor: @${user.username}\nBranch: ${mr.source_branch} → ${mr.target_branch}\nURL: ${mr.url}\n\n${context ? `Context: ${context}\n\n` : ""}${getCommandSuggestions("mr")}${DELEGATION_INSTRUCTION}`;

      const task = createTaskExtended(taskDesc, {
        agentId: lead?.id ?? null,
        source: "gitlab",
        vcsProvider: "gitlab",
        taskType: "gitlab-mr",
        vcsRepo: repo,
        vcsEventType: "merge_request",
        vcsNumber: mr.iid,
        vcsAuthor: user.username,
        vcsUrl: mr.url,
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
      const taskDesc = `[GitLab Issue #${issue.iid}] ${issue.title}\n\nRepo: ${repo}\nAuthor: @${user.username}\nURL: ${issue.url}\n\n${context ? `Context: ${context}\n\n` : ""}${getCommandSuggestions("issue")}${DELEGATION_INSTRUCTION}`;

      const task = createTaskExtended(taskDesc, {
        agentId: lead?.id ?? null,
        source: "gitlab",
        vcsProvider: "gitlab",
        taskType: "gitlab-issue",
        vcsRepo: repo,
        vcsEventType: "issue",
        vcsNumber: issue.iid,
        vcsAuthor: user.username,
        vcsUrl: issue.url,
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

  const taskDesc = `[GitLab Comment on ${entityLabel}] @${user.username} mentioned bot\n\nRepo: ${repo}\nURL: ${targetUrl}\n\nComment:\n${context}${existingTask ? `\n\n_Note: There's an active task (${existingTask.id}) for this ${entityLabel}._` : ""}${DELEGATION_INSTRUCTION}`;

  const task = createTaskExtended(taskDesc, {
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
  const taskDesc = `[GitLab CI Failed] Pipeline #${pipeline.id} failed for MR #${mrIid}\n\nRepo: ${repo}\nMR: ${event.merge_request.title}\nURL: ${event.merge_request.url}\nBranch: ${event.merge_request.source_branch}\n\nThe CI pipeline has failed. Please investigate and fix the issues.${DELEGATION_INSTRUCTION}`;

  const task = createTaskExtended(taskDesc, {
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
  });

  return { created: true, taskId: task.id };
}
