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

/** Keep aggregate SQL matching aligned with extractGitHubPullRequestUrls(). */
function githubPullRequestExistsSql(value: string): string {
  return `EXISTS (
    WITH RECURSIVE
    normalized(value) AS (
      SELECT trim(
        replace(replace(replace(replace(
        replace(replace(replace(replace(replace(replace(replace(replace(replace(replace(
          coalesce(${value}, ''), char(9), ' '), char(10), ' '), char(13), ' '),
          '(', ' '), ')', ' '), '[', ' '), ']', ' '), '{', ' '), '}', ' '), '<', ' '),
          '>', ' '), char(34), ' '), char(39), ' '), char(96), ' ')
      )
    ),
    tokens(remaining, token) AS (
      SELECT value || ' ', NULL FROM normalized

      UNION ALL

      SELECT
        ltrim(substr(remaining, instr(remaining, ' ') + 1)),
        substr(remaining, 1, instr(remaining, ' ') - 1)
      FROM tokens
      WHERE remaining <> ''
    ),
    github_paths(path) AS (
      SELECT CASE
        WHEN lower(token) GLOB 'https://github.com/*'
          THEN substr(token, length('https://github.com/') + 1)
        WHEN lower(token) GLOB 'http://github.com/*'
          THEN substr(token, length('http://github.com/') + 1)
        ELSE substr(token, length('github.com/') + 1)
      END
      FROM tokens
      WHERE lower(token) GLOB 'https://github.com/*'
         OR lower(token) GLOB 'http://github.com/*'
         OR lower(token) GLOB 'github.com/*'
    ),
    github_segments(owner, repo, remainder) AS (
      SELECT
        substr(path, 1, instr(path, '/') - 1),
        substr(
          substr(path, instr(path, '/') + 1),
          1,
          instr(substr(path, instr(path, '/') + 1), '/') - 1
        ),
        substr(
          substr(path, instr(path, '/') + 1),
          instr(substr(path, instr(path, '/') + 1), '/') + 1
        )
      FROM github_paths
      WHERE instr(path, '/') > 1
        AND instr(substr(path, instr(path, '/') + 1), '/') > 1
    ),
    github_pull_numbers(remainder, position) AS (
      SELECT remainder, length('pull/') + 1
      FROM github_segments
      WHERE owner NOT GLOB '*[^A-Za-z0-9._-]*'
        AND repo NOT GLOB '*[^A-Za-z0-9._-]*'
        AND lower(remainder) GLOB 'pull/[0-9]*'

      UNION ALL

      SELECT remainder, position + 1
      FROM github_pull_numbers
      WHERE substr(remainder, position, 1) GLOB '[0-9]'
    )
    SELECT 1
    FROM github_pull_numbers
    WHERE substr(remainder, position, 1) NOT GLOB '[0-9]'
      AND (
        substr(remainder, position, 1) = ''
        OR unicode(substr(remainder, position, 1)) IN (
          9, 10, 13, 32, 33, 34, 35, 39, 41, 44, 46, 47, 58, 59, 62, 63, 93, 96, 125
        )
      )
    LIMIT 1
  )`;
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
  const outputHasPullRequest = githubPullRequestExistsSql(`${t}.output`);
  const hasAnyAttachment = `EXISTS (
    SELECT 1 FROM task_attachments ta WHERE ta.task_id = ${t}.id
  )`;
  const hasPullRequestAttachment = `EXISTS (
    SELECT 1 FROM task_attachments ta
    WHERE ta.task_id = ${t}.id
      AND ta.kind = 'url'
      AND ${githubPullRequestExistsSql("ta.url")}
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
