/**
 * Who sent a Comb batch, when the request names no user.
 *
 * The dashboard sends with the swarm API key, so the request carries no user.
 * The comment authors do: an agent-fs author maps to a swarm user through a
 * linked `agent-fs` identity, else through the email agent-fs has for that
 * drive member. The browser's agent-fs key never reaches the swarm API, so no
 * request proves which author pressed Send. With several mapped authors, the
 * author of the newest comment wins: the person who commented last is the
 * one most likely to have sent the batch.
 */

import { findUserByEmail, findUserByExternalId } from "../be/users";
import type { AgentFsComment, AgentFsDrive, AgentFsProvider } from "../fs/agent-fs-provider";
import { scrubSecrets } from "../utils/secret-scrubber";

/** `user_external_ids.kind` of an agent-fs user id. */
export const AGENT_FS_IDENTITY_KIND = "agent-fs";

/**
 * agent-fs user id -> swarm user id, for each author that maps. The swarm
 * service account is never a requester. Reads the drive members from
 * agent-fs only when an author has no linked identity.
 */
export async function commentAuthorUsers(
  agentFs: AgentFsProvider,
  drive: AgentFsDrive,
  comments: AgentFsComment[],
  serviceUserId: string,
): Promise<Map<string, string>> {
  const authors = [...new Set(comments.map((comment) => comment.author))].filter(
    (author) => author && author !== serviceUserId,
  );
  const users = new Map<string, string>();
  const unlinked: string[] = [];
  for (const author of authors) {
    const user = await findUserByExternalId(AGENT_FS_IDENTITY_KIND, author);
    if (user) users.set(author, user.id);
    else unlinked.push(author);
  }
  if (unlinked.length === 0) return users;

  const members = await agentFs.getDriveMembers(drive).catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(scrubSecrets(`[comb] could not read the drive members: ${message}`));
    return [];
  });
  for (const author of unlinked) {
    const email = members.find((member) => member.userId === author)?.email;
    const user = email ? await findUserByEmail(email) : null;
    if (user) users.set(author, user.id);
  }
  return users;
}

/** The author of the newest comment that maps to a swarm user, else null. */
export function batchRequester(
  comments: AgentFsComment[],
  users: Map<string, string>,
): string | null {
  let newest: AgentFsComment | null = null;
  for (const comment of comments) {
    if (!users.has(comment.author)) continue;
    if (!newest || Date.parse(comment.createdAt) > Date.parse(newest.createdAt)) {
      newest = comment;
    }
  }
  return newest ? (users.get(newest.author) ?? null) : null;
}
