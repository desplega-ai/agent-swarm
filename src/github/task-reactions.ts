import type { AgentTask } from "../types";
import {
  addGraphQLReaction,
  addIssueReaction,
  addPullReviewCommentReaction,
  addReaction,
} from "./reactions";

/**
 * Add an 👀 eyes reaction to the source GitHub comment/review when a task starts.
 * Called when a task transitions to `in_progress`.
 *
 * Handles three GitHub event types:
 * - issue_comment: REST reaction on issue comment
 * - pull_request_review_comment: REST reaction on PR review comment (inline)
 * - pull_request_review: GraphQL reaction on review body (REST doesn't support review reactions)
 */
export async function addEyesReactionOnTaskStart(task: AgentTask): Promise<void> {
  // Only for GitHub-sourced tasks with installation info
  if (task.source !== "github" || task.vcsProvider !== "github") return;
  if (!task.vcsInstallationId) return;

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
    // Never fail the task start due to a reaction error
    console.error("[GitHub] Failed to add eyes reaction on task start:", error);
  }
}
