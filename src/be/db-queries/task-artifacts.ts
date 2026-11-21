import { getGitHubHostForSql } from "../../utils/github-host";
import { extractGitHubPullRequestUrls } from "../../utils/github-pull-request";
import { getStorage } from "../storage";

export type TaskShippingEvidenceSource = "attachment" | "output-fallback" | "none";

export interface TaskShippingEvidence {
  hasArtifact: boolean;
  hasPullRequest: boolean;
  pullRequestUrls: string[];
  pullRequestSource: TaskShippingEvidenceSource;
}

/**
 * SQL expressions for aggregate task-reporting queries, as text for callers
 * that splice SQL. Attachment rows are authoritative; output matching remains a
 * compatibility fallback while old databases are upgraded/backfilled. The
 * tasks repository builds them (matching `extractGitHubPullRequestUrls`).
 */
export function taskShippingEvidenceSql(alias = "t"): {
  hasArtifact: string;
  hasPullRequest: string;
} {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid task SQL alias: ${alias}`);
  }
  const storage = getStorage();
  const evidence = storage.repos.tasks.shippingEvidenceSql(alias, getGitHubHostForSql());
  return {
    hasArtifact: evidence.hasArtifact.render(storage.dialect).text,
    hasPullRequest: evidence.hasPullRequest.render(storage.dialect).text,
  };
}

/** Look up one task's attachment-first shipping evidence. */
export async function getTaskShippingEvidence(
  taskId: string,
): Promise<TaskShippingEvidence | null> {
  const repo = getStorage().repos.tasks;
  const task = await repo.findTaskOutput(taskId);
  if (!task) return null;

  const attachments = await repo.listTaskAttachmentUrls(taskId);
  const attachmentPullRequests = Array.from(
    new Set(
      attachments.flatMap((attachment) =>
        attachment.kind === "url"
          ? extractGitHubPullRequestUrls(attachment.url).map((pullRequest) => pullRequest.url)
          : [],
      ),
    ),
  );

  if (attachmentPullRequests.length > 0) {
    return {
      hasArtifact: true,
      hasPullRequest: true,
      pullRequestUrls: attachmentPullRequests,
      pullRequestSource: "attachment",
    };
  }

  const fallbackPullRequests = extractGitHubPullRequestUrls(task.output).map(
    (pullRequest) => pullRequest.url,
  );
  return {
    hasArtifact: attachments.length > 0 || fallbackPullRequests.length > 0,
    hasPullRequest: fallbackPullRequests.length > 0,
    pullRequestUrls: fallbackPullRequests,
    pullRequestSource: fallbackPullRequests.length > 0 ? "output-fallback" : "none",
  };
}
