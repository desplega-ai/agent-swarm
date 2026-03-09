/**
 * GitLab API interactions — reactions (award emoji) and comments (notes).
 * Uses raw fetch, no SDK.
 */

import { getGitLabToken, getGitLabUrl } from "./auth";

function headers(): Record<string, string> {
  const token = getGitLabToken();
  if (!token) throw new Error("[GitLab] No API token configured");
  return {
    "PRIVATE-TOKEN": token,
    "Content-Type": "application/json",
  };
}

function apiBase(): string {
  return `${getGitLabUrl()}/api/v4`;
}

/** Encode a project path (e.g. "group/project") for use in API URLs. */
function encodeProject(pathWithNamespace: string): string {
  return encodeURIComponent(pathWithNamespace);
}

/**
 * Add an award emoji (reaction) to a merge request or issue.
 * GitLab calls reactions "award emoji".
 * @see https://docs.gitlab.com/ee/api/award_emoji.html
 */
export async function addGitLabReaction(
  project: string,
  entityType: "issue" | "mr",
  iid: number,
  emojiName: string,
): Promise<void> {
  const resourceType = entityType === "mr" ? "merge_requests" : "issues";
  const url = `${apiBase()}/projects/${encodeProject(project)}/${resourceType}/${iid}/award_emoji`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: emojiName }),
    });
    if (!resp.ok) {
      console.error(`[GitLab] Failed to add reaction: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`[GitLab] Error adding reaction:`, err);
  }
}

/**
 * Add an award emoji (reaction) to a specific note (comment).
 * @see https://docs.gitlab.com/ee/api/award_emoji.html#award-a-new-emoji-on-a-comment
 */
export async function addGitLabNoteReaction(
  project: string,
  entityType: "issue" | "mr",
  iid: number,
  noteId: number,
  emojiName: string,
): Promise<void> {
  const resourceType = entityType === "mr" ? "merge_requests" : "issues";
  const url = `${apiBase()}/projects/${encodeProject(project)}/${resourceType}/${iid}/notes/${noteId}/award_emoji`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ name: emojiName }),
    });
    if (!resp.ok) {
      console.error(`[GitLab] Failed to add note reaction: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`[GitLab] Error adding note reaction:`, err);
  }
}

/**
 * Post a comment (note) on a merge request or issue.
 * @see https://docs.gitlab.com/ee/api/notes.html
 */
export async function postGitLabComment(
  project: string,
  entityType: "issue" | "mr",
  iid: number,
  body: string,
): Promise<void> {
  const resourceType = entityType === "mr" ? "merge_requests" : "issues";
  const url = `${apiBase()}/projects/${encodeProject(project)}/${resourceType}/${iid}/notes`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ body }),
    });
    if (!resp.ok) {
      console.error(`[GitLab] Failed to post comment: ${resp.status} ${await resp.text()}`);
    }
  } catch (err) {
    console.error(`[GitLab] Error posting comment:`, err);
  }
}
