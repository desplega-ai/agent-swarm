import { extractGitHubPullRequestUrls } from "../../utils/github-pull-request";
import { getDb } from "../db";

export type TaskShippingEvidenceSource = "attachment" | "output-fallback" | "none";

export interface TaskShippingEvidence {
  hasArtifact: boolean;
  hasPullRequest: boolean;
  pullRequestUrls: string[];
  pullRequestSource: TaskShippingEvidenceSource;
}

function taskAlias(alias: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(alias)) {
    throw new Error(`Invalid task SQL alias: ${alias}`);
  }
  return alias;
}

/**
 * SQL expressions for aggregate task-reporting queries. Attachment rows are
 * authoritative; output matching remains a compatibility fallback while old
 * databases are upgraded/backfilled.
 */
export function taskShippingEvidenceSql(alias = "t"): {
  hasArtifact: string;
  hasPullRequest: string;
} {
  const t = taskAlias(alias);
  const outputHasPullRequest = `(
    lower(${t}.output) GLOB 'github.com/*/*/pull/[0-9]*'
    OR lower(${t}.output) GLOB '*[^a-z0-9._-]github.com/*/*/pull/[0-9]*'
  )`;
  const hasAnyAttachment = `EXISTS (
    SELECT 1 FROM task_attachments ta WHERE ta.task_id = ${t}.id
  )`;
  const hasPullRequestAttachment = `EXISTS (
    SELECT 1 FROM task_attachments ta
    WHERE ta.task_id = ${t}.id
      AND ta.kind = 'url'
      AND (
        lower(ta.url) GLOB 'https://github.com/*/*/pull/[0-9]*'
        OR lower(ta.url) GLOB 'http://github.com/*/*/pull/[0-9]*'
        OR lower(ta.url) GLOB 'github.com/*/*/pull/[0-9]*'
      )
  )`;

  return {
    hasArtifact: `CASE WHEN ${hasAnyAttachment} THEN 1 WHEN ${outputHasPullRequest} THEN 1 ELSE 0 END`,
    hasPullRequest: `CASE WHEN ${hasPullRequestAttachment} THEN 1 WHEN ${outputHasPullRequest} THEN 1 ELSE 0 END`,
  };
}

/** Look up one task's attachment-first shipping evidence. */
export function getTaskShippingEvidence(taskId: string): TaskShippingEvidence | null {
  const task = getDb()
    .prepare<{ output: string | null }, [string]>("SELECT output FROM agent_tasks WHERE id = ?")
    .get(taskId);
  if (!task) return null;

  const attachments = getDb()
    .prepare<{ kind: string; url: string | null }, [string]>(
      "SELECT kind, url FROM task_attachments WHERE task_id = ? ORDER BY created_at, rowid",
    )
    .all(taskId);
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
