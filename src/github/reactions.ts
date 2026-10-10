import { scrubSecrets } from "../utils/secret-scrubber";
import { getInstallationToken, isReactionsEnabled } from "./app";

export type ReactionType = "eyes" | "+1" | "rocket" | "heart";

export type GraphQLReactionType =
  | "THUMBS_UP"
  | "THUMBS_DOWN"
  | "LAUGH"
  | "HOORAY"
  | "CONFUSED"
  | "HEART"
  | "ROCKET"
  | "EYES";

/**
 * Pick the credential a reaction call authenticates with.
 *
 *   1. GitHub App installation token: App credentials are loaded and the event
 *      carried an installation id. The reaction appears as the bot.
 *   2. `GITHUB_TOKEN` (PAT): deployments that use a plain webhook plus a PAT and
 *      never installed an App. The reaction appears as the PAT's user.
 *
 * Returns null when neither exists, so callers skip instead of throwing. A
 * reaction is best-effort and must never block task creation. The token is
 * never logged.
 */
async function resolveReactionToken(installationId?: number | null): Promise<string | null> {
  if (installationId && isReactionsEnabled()) {
    const appToken = await getInstallationToken(installationId);
    if (appToken) return appToken;
    console.log("[GitHub] No installation token, trying GITHUB_TOKEN for reaction");
  }

  const pat = process.env.GITHUB_TOKEN?.trim();
  if (pat) return pat;

  console.log("[GitHub] No App installation and no GITHUB_TOKEN, skipping reaction");
  return null;
}

/**
 * POST a reaction to one of GitHub's REST `.../reactions` endpoints.
 * `target` is the path after `/repos/{repo}/`, e.g. `issues/comments/42`.
 */
async function postRestReaction(
  repo: string,
  target: string,
  reaction: ReactionType,
  installationId: number | null | undefined,
  label: string,
): Promise<boolean> {
  const token = await resolveReactionToken(installationId);
  if (!token) return false;

  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/${target}/reactions`, {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ content: reaction }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[GitHub] Failed to add ${label} reaction: ${response.status} ${scrubSecrets(errorText)}`,
      );
      return false;
    }

    console.log(`[GitHub] Added ${reaction} reaction to ${label}`);
    return true;
  } catch (error) {
    console.error(
      `[GitHub] Error adding ${label} reaction:`,
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

/**
 * Add a reaction to a PR/issue conversation comment (`issues/comments`).
 * Inline diff comments use {@link addPullReviewCommentReaction} instead.
 * Uses the App installation token when available, else `GITHUB_TOKEN`.
 */
export async function addReaction(
  repo: string,
  commentId: number,
  reaction: ReactionType,
  installationId?: number | null,
): Promise<boolean> {
  return postRestReaction(
    repo,
    `issues/comments/${commentId}`,
    reaction,
    installationId,
    `comment ${commentId}`,
  );
}

/**
 * Add a reaction to an issue or PR itself (not a comment).
 * Uses the App installation token when available, else `GITHUB_TOKEN`.
 */
export async function addIssueReaction(
  repo: string,
  issueNumber: number,
  reaction: ReactionType,
  installationId?: number | null,
): Promise<boolean> {
  return postRestReaction(
    repo,
    `issues/${issueNumber}`,
    reaction,
    installationId,
    `issue/PR #${issueNumber}`,
  );
}

/**
 * Add a reaction to a PR review comment (inline comment on a diff).
 * Uses the pulls/comments endpoint (different from issues/comments).
 * Uses the App installation token when available, else `GITHUB_TOKEN`.
 */
export async function addPullReviewCommentReaction(
  repo: string,
  commentId: number,
  reaction: ReactionType,
  installationId?: number | null,
): Promise<boolean> {
  return postRestReaction(
    repo,
    `pulls/comments/${commentId}`,
    reaction,
    installationId,
    `PR review comment ${commentId}`,
  );
}

/**
 * Add a reaction via the GraphQL API (for PR review bodies which REST doesn't support)
 * Requires the node_id of the subject.
 * Uses the App installation token when available, else `GITHUB_TOKEN`.
 */
export async function addGraphQLReaction(
  nodeId: string,
  reaction: GraphQLReactionType,
  installationId?: number | null,
): Promise<boolean> {
  const token = await resolveReactionToken(installationId);
  if (!token) return false;

  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query: `mutation AddReaction($input: AddReactionInput!) {
          addReaction(input: $input) {
            reaction { content }
          }
        }`,
        variables: {
          input: { subjectId: nodeId, content: reaction },
        },
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(
        `[GitHub] GraphQL reaction failed: ${response.status} ${scrubSecrets(errorText)}`,
      );
      return false;
    }

    const data = (await response.json()) as { errors?: Array<{ message: string }> };
    if (data.errors?.length) {
      console.error(
        `[GitHub] GraphQL reaction errors: ${scrubSecrets(JSON.stringify(data.errors))}`,
      );
      return false;
    }

    console.log(`[GitHub] Added ${reaction} GraphQL reaction to node ${nodeId}`);
    return true;
  } catch (error) {
    console.error(
      "[GitHub] Error adding GraphQL reaction:",
      scrubSecrets(error instanceof Error ? error.message : String(error)),
    );
    return false;
  }
}

/**
 * Post a comment on an issue or PR
 * Appears as agent-swarm-bot[bot] commenting
 */
export async function postComment(
  repo: string,
  issueNumber: number,
  body: string,
  installationId: number,
): Promise<boolean> {
  if (!isReactionsEnabled()) {
    console.log("[GitHub] Reactions not enabled, skipping comment");
    return false;
  }

  const token = await getInstallationToken(installationId);
  if (!token) {
    console.log("[GitHub] No installation token, skipping comment");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/comments`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ body }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GitHub] Failed to post comment: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[GitHub] Posted comment on issue/PR #${issueNumber}`);
    return true;
  } catch (error) {
    console.error("[GitHub] Error posting comment:", error);
    return false;
  }
}
