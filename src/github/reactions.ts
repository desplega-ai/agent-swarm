import { getInstallationToken, isReactionsEnabled } from "./app";

export type ReactionType = "eyes" | "+1" | "rocket" | "heart";

/**
 * Add a reaction to a comment (issue comment or PR review comment)
 * Appears as agent-swarm-bot[bot] reacting
 */
export async function addReaction(
  repo: string,
  commentId: number,
  reaction: ReactionType,
  installationId: number,
): Promise<boolean> {
  if (!isReactionsEnabled()) {
    console.log("[GitHub] Reactions not enabled, skipping");
    return false;
  }

  const token = await getInstallationToken(installationId);
  if (!token) {
    console.log("[GitHub] No installation token, skipping reaction");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/comments/${commentId}/reactions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: reaction }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GitHub] Failed to add reaction: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[GitHub] Added ${reaction} reaction to comment ${commentId}`);
    return true;
  } catch (error) {
    console.error("[GitHub] Error adding reaction:", error);
    return false;
  }
}

/**
 * Add a reaction to an issue or PR (not a comment)
 * Appears as agent-swarm-bot[bot] reacting
 */
export async function addIssueReaction(
  repo: string,
  issueNumber: number,
  reaction: ReactionType,
  installationId: number,
): Promise<boolean> {
  if (!isReactionsEnabled()) {
    console.log("[GitHub] Reactions not enabled, skipping");
    return false;
  }

  const token = await getInstallationToken(installationId);
  if (!token) {
    console.log("[GitHub] No installation token, skipping reaction");
    return false;
  }

  try {
    const response = await fetch(
      `https://api.github.com/repos/${repo}/issues/${issueNumber}/reactions`,
      {
        method: "POST",
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${token}`,
          "X-GitHub-Api-Version": "2022-11-28",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ content: reaction }),
      },
    );

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[GitHub] Failed to add issue reaction: ${response.status} ${errorText}`);
      return false;
    }

    console.log(`[GitHub] Added ${reaction} reaction to issue/PR #${issueNumber}`);
    return true;
  } catch (error) {
    console.error("[GitHub] Error adding issue reaction:", error);
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
