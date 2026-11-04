// What "Needs you" on Home lists, and the count the sidebar Home badge shows.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type {
  AgentTask,
  ApprovalRequestSummary,
  CredentialMissingAgent,
  SessionListItem,
} from "../api/types";

export interface NeedsYouItems {
  approvals: ApprovalRequestSummary[];
  /** Sessions that need you for a reason other than a listed approval. */
  sessions: SessionListItem[];
  credentials: CredentialMissingAgent[];
}

/** A session is "unread with a failed latest status": the other cause of `needsYou`. */
function isUnreadFailure(session: SessionListItem): boolean {
  return session.readState === "unread" && session.latestStatus === "failed";
}

/**
 * The rows of "Needs you", deduped. A session needs you for an unread failure
 * or for a pending approval in its chain. Every pending approval is listed on
 * its own, so a session shows once, under approvals: it drops out when its
 * root is an approval's source task, and when only an approval explains its
 * `needsYou` (the approval can come from a child task of the chain). While
 * approvals are unknown (loading or failed), every session stays, so nothing
 * that needs the viewer disappears. An approval the viewer cannot answer
 * (`viewerCanRespond: false`, the respond route would refuse) is not listed.
 */
export function needsYouItems(input: {
  approvals: ApprovalRequestSummary[] | undefined;
  sessions: SessionListItem[] | undefined;
  credentials: CredentialMissingAgent[] | undefined;
}): NeedsYouItems {
  const approvals = (input.approvals ?? []).filter(
    (approval) => approval.viewerCanRespond !== false,
  );
  const sources = new Set(approvals.map((approval) => approval.sourceTaskId).filter(Boolean));
  const sessions = (input.sessions ?? []).filter((session) => {
    if (session.needsYou === false) return false;
    if (input.approvals === undefined) return true;
    if (sources.has(session.root.id)) return false;
    return isUnreadFailure(session);
  });
  return { approvals, sessions, credentials: input.credentials ?? [] };
}

/** How often the sidebar Home badge polls off Home. On Home it follows the widget's reads. */
export const NEEDS_YOU_BADGE_POLL_MS = 30_000;

/** The badge's poll for `pathname`: undefined keeps each read's own poll (Home). */
export function needsYouBadgePoll(pathname: string): number | undefined {
  return pathname === "/" ? undefined : NEEDS_YOU_BADGE_POLL_MS;
}

/** The Needs-you count: the sidebar Home badge and the widget's pill. */
export function needsYouCount(items: NeedsYouItems): number {
  return items.approvals.length + items.sessions.length + items.credentials.length;
}

/** Failed tasks of the last 24h minus the roots already listed as sessions that need you. */
export function failuresNotListed(failures: AgentTask[], sessions: SessionListItem[]): AgentTask[] {
  const listed = new Set(sessions.map((session) => session.root.id));
  return failures.filter((task) => !listed.has(task.id));
}
