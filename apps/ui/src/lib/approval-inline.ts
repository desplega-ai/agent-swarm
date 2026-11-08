import type { ApprovalQuestion, ApprovalRequest, User } from "../api/types";
import { hasAnswered, OPERATOR_RESPONDER } from "./approval-format";

/**
 * Whether a session's approval card may show the answer form in place, or
 * only the `Review ->` link to the full page.
 *
 * Only relative imports here: root-run tests import this module directly and
 * cannot resolve the `@/` alias.
 */

/** Who the tab answers as, from `GET /api/whoami`. Null while unknown. */
export type InlineViewer = { kind: "operator" } | { kind: "user"; user: User } | null;

/** The question types the inline form renders. `config` writes swarm config and stays on the full page. */
const INLINE_TYPES = new Set<ApprovalQuestion["type"]>([
  "approval",
  "boolean",
  "single-select",
  "multi-select",
  "text",
]);

function userMatches(user: User, listed: string): boolean {
  if (listed === user.id) return true;
  return !!user.email && listed.toLowerCase() === user.email.toLowerCase();
}

/**
 * Mirrors the server's `isListedApprover` (src/http/approval-requests.ts),
 * stricter in two places so the inline form is never an easier way to answer
 * for someone else than the full page:
 * - the operator key answers inline only when the request lists no users or
 *   roles (the server lets it override any list; that stays a full-page act);
 * - under `all` with listed users, only a listed user answers inline, since
 *   any other vote never counts toward the quorum.
 */
function mayAnswer(approvers: ApprovalRequest["approvers"], viewer: NonNullable<InlineViewer>) {
  const users = approvers.users ?? [];
  const roles = approvers.roles ?? [];
  if (users.length === 0 && roles.length === 0) return true;
  if (viewer.kind === "operator") return false;
  const listed = users.some((entry) => userMatches(viewer.user, entry));
  if (approvers.policy === "all" && users.length > 0) return listed;
  return listed || (!!viewer.user.role && roles.includes(viewer.user.role));
}

/** The responder id the server records for this viewer. */
export function viewerResponder(viewer: InlineViewer): string | null {
  if (!viewer) return null;
  return viewer.kind === "operator" ? OPERATOR_RESPONDER : viewer.user.id;
}

/**
 * `true` when the card shows the form inline: the request is pending and not
 * expired, the role grants `approval.respond`, the viewer is known, listed as
 * an approver and has not answered yet, and every question renders inline.
 */
export function canAnswerInline(
  request: Pick<ApprovalRequest, "status" | "questions" | "approvers" | "approvals" | "expiresAt">,
  viewer: InlineViewer,
  canRespond: boolean,
  now: number = Date.now(),
): boolean {
  if (request.status !== "pending" || !canRespond || !viewer) return false;
  if (request.expiresAt && Date.parse(request.expiresAt) <= now) return false;
  if (request.questions.length === 0) return false;
  if (!request.questions.every((question) => INLINE_TYPES.has(question.type))) return false;
  if (hasAnswered(request, viewerResponder(viewer))) return false;
  return mayAnswer(request.approvers, viewer);
}
