import { onTaskStarted } from "../be/task-lifecycle-events";
import type { AgentTask } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  addGraphQLReaction,
  addIssueReaction,
  addPullReviewCommentReaction,
  addReaction,
} from "./reactions";

/**
 * Add an 👀 eyes reaction to the GitHub item that triggered a task: the comment,
 * review, or issue/PR body. Never throws, because a reaction must not fail task
 * creation or task start.
 *
 * Called by the webhook handlers right after they create the task, and again when
 * the task transitions to `in_progress`. GitHub treats a repeated reaction from the
 * same user as a no-op, so the second call is harmless.
 *
 * Auth is chosen in `./reactions`: the App installation token when the task carries
 * an installation id, else `GITHUB_TOKEN`. Deployments that use a plain webhook plus
 * a PAT have no installation id, so it is not required here.
 *
 * Handles these GitHub event types, each with its own endpoint:
 * - issue_comment: REST `issues/comments/{id}`
 * - pull_request_review_comment: REST `pulls/comments/{id}` (inline diff comment)
 * - pull_request_review: GraphQL on the review node (REST can't react to a review),
 *   falling back to the PR itself when the payload had no node id
 * - pull_request / issues: REST `issues/{number}` (the issue or PR body)
 */
export async function addEyesReactionToTaskSource(task: AgentTask): Promise<void> {
  if (task.source !== "github" || task.vcsProvider !== "github") return;

  const installationId = task.vcsInstallationId;
  const repo = task.vcsRepo;
  if (!repo) return;

  try {
    switch (task.vcsEventType) {
      case "issue_comment": {
        // Issue comment — use REST issues/comments endpoint
        if (task.vcsCommentId) {
          await addReaction(repo, task.vcsCommentId, "eyes", installationId);
        }
        break;
      }

      case "pull_request_review_comment": {
        // Inline PR review comment — use REST pulls/comments endpoint
        if (task.vcsCommentId) {
          await addPullReviewCommentReaction(repo, task.vcsCommentId, "eyes", installationId);
        }
        break;
      }

      case "pull_request_review": {
        // PR review body — requires GraphQL API
        if (task.vcsNodeId) {
          await addGraphQLReaction(task.vcsNodeId, "EYES", installationId);
        } else if (task.vcsNumber) {
          await addIssueReaction(repo, task.vcsNumber, "eyes", installationId);
        }
        break;
      }

      case "pull_request":
      case "issues": {
        // PR or issue opened/labeled — react on the issue/PR itself
        if (task.vcsNumber) {
          await addIssueReaction(repo, task.vcsNumber, "eyes", installationId);
        }
        break;
      }
    }
  } catch (error) {
    // Never fail task creation or start due to a reaction error
    console.error(
      "[GitHub] Failed to add eyes reaction:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
  }
}

/**
 * Add an 👀 eyes reaction to the source GitHub item when a task starts.
 * Called when a task transitions to `in_progress`.
 */
export async function addEyesReactionOnTaskStart(task: AgentTask): Promise<void> {
  await addEyesReactionToTaskSource(task);
}

let registered = false;

/**
 * Subscribe the GitHub eyes-reaction handler to the task-started lifecycle event.
 *
 * Call this once at API-server boot (from `createServer`). It is the API-side
 * inverse of the old `be/db` → `github/task-reactions` import: the data layer now
 * emits `task-started` and this integration reacts. Idempotent — `createServer`
 * may run more than once per process, so repeated calls register only once.
 *
 * API-server only — never wire this on the worker side.
 */
export function registerGithubTaskReactions(): void {
  if (registered) return;
  registered = true;
  onTaskStarted((task) => {
    addEyesReactionOnTaskStart(task).catch(() => {});
  });
}
