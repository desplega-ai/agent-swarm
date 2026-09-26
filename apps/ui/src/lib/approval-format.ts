import type { ApprovalQuestion, ApprovalRequest } from "../api/types";
import { hasRequiredResponse } from "./approval-responses";

/**
 * Human rendering for approval-request answers and state, so the page never
 * shows raw JSON (`{"approved":false}`) where a person expects a word.
 */

export type AnswerTone = "success" | "error" | "neutral" | "empty";

export interface FormattedAnswer {
  /** How to draw it: a decision word, option chips, free text, or nothing. */
  kind: "decision" | "choice" | "choices" | "text" | "empty" | "raw";
  tone: AnswerTone;
  /** One-line summary ("Rejected", "Staging", "Lint, Tests", the typed text). */
  text: string;
  /** Multi-select: one label per picked option. */
  items?: string[];
  /** A free-text note sent with a decision (`{ approved, comment }`). */
  note?: string;
}

const EMPTY: FormattedAnswer = { kind: "empty", tone: "empty", text: "No answer" };

function optionLabel(question: ApprovalQuestion, value: string): string {
  return question.options?.find((option) => option.value === value)?.label ?? value;
}

function raw(response: unknown): FormattedAnswer {
  let text: string;
  try {
    text = JSON.stringify(response) ?? String(response);
  } catch {
    text = String(response);
  }
  return { kind: "raw", tone: "neutral", text };
}

export function formatApprovalAnswer(
  question: ApprovalQuestion,
  response: unknown,
): FormattedAnswer {
  if (response === null || response === undefined) return EMPTY;
  switch (question.type) {
    case "approval": {
      if (typeof response !== "object" || Array.isArray(response)) return raw(response);
      const { approved, comment, reason } = response as {
        approved?: unknown;
        comment?: unknown;
        reason?: unknown;
      };
      if (typeof approved !== "boolean") return raw(response);
      const noteSource = typeof comment === "string" ? comment : reason;
      const note =
        typeof noteSource === "string" && noteSource.trim() ? noteSource.trim() : undefined;
      return approved
        ? { kind: "decision", tone: "success", text: "Approved", note }
        : { kind: "decision", tone: "error", text: "Rejected", note };
    }
    case "boolean":
      if (typeof response !== "boolean") return raw(response);
      return { kind: "decision", tone: "neutral", text: response ? "Yes" : "No" };
    case "single-select":
      if (typeof response !== "string") return raw(response);
      if (!response) return EMPTY;
      return { kind: "choice", tone: "neutral", text: optionLabel(question, response) };
    case "multi-select": {
      if (!Array.isArray(response)) return raw(response);
      if (response.length === 0) return { kind: "empty", tone: "empty", text: "None selected" };
      const items = response.map((value) =>
        typeof value === "string" ? optionLabel(question, value) : String(value),
      );
      return { kind: "choices", tone: "neutral", text: items.join(", "), items };
    }
    case "text":
      if (typeof response !== "string") return raw(response);
      if (!response.trim()) return EMPTY;
      return { kind: "text", tone: "neutral", text: response };
    default:
      return raw(response);
  }
}

/** True when the response is a complete, valid answer (optional or not). */
export function isAnswered(question: ApprovalQuestion, response: unknown): boolean {
  return hasRequiredResponse(question, response);
}

/**
 * What the question still needs, in words ("Pick at least 2"). `null` when
 * nothing blocks: answered, or optional and untouched.
 */
export function answerHint(question: ApprovalQuestion, response: unknown): string | null {
  if (isAnswered(question, response)) return null;
  const touched =
    response !== undefined &&
    response !== null &&
    !(typeof response === "string" && response.trim() === "") &&
    !(Array.isArray(response) && response.length === 0);
  if (!question.required && !touched) return null;
  switch (question.type) {
    case "approval":
      return "Approve or reject to continue";
    case "boolean":
      return "Choose yes or no";
    case "text":
      return "Type a response";
    case "single-select":
      return "Pick one option";
    case "multi-select": {
      const count = Array.isArray(response) ? response.length : 0;
      const min = Math.max(1, question.minSelections ?? 0);
      if (question.maxSelections !== undefined && count > question.maxSelections) {
        return `Pick at most ${question.maxSelections}`;
      }
      return `Pick at least ${min}`;
    }
    default:
      return "Answer this question";
  }
}

/** "Pick 1–3" style range for a multi-select, or null when it is just "any". */
export function selectionRange(question: ApprovalQuestion): string | null {
  const min = question.minSelections;
  const max = question.maxSelections;
  if (min && max) return min === max ? `Pick ${min}` : `Pick ${min}–${max}`;
  if (min && min > 1) return `Pick at least ${min}`;
  if (max) return `Pick up to ${max}`;
  return null;
}

export interface AnswerProgress {
  answered: number;
  total: number;
  /** Required questions without a valid answer. */
  missingRequired: number;
  /** Invalid answers on optional questions (for example too many picks). */
  invalidOptional: number;
  /** Why Submit is blocked, or null when it can submit. */
  blockedReason: string | null;
  /** At least one approval question is answered "reject". */
  rejects: boolean;
}

export function answerProgress(
  questions: ApprovalQuestion[],
  responses: Record<string, unknown>,
): AnswerProgress {
  let answered = 0;
  let missingRequired = 0;
  let invalidOptional = 0;
  let rejects = false;
  for (const question of questions) {
    const response = responses[question.id];
    if (isAnswered(question, response)) answered += 1;
    else if (question.required) missingRequired += 1;
    else if (answerHint(question, response)) invalidOptional += 1;
    if (
      question.type === "approval" &&
      (response as { approved?: unknown } | undefined)?.approved === false
    ) {
      rejects = true;
    }
  }
  let blockedReason: string | null = null;
  if (missingRequired > 0) {
    blockedReason =
      missingRequired === 1
        ? "Answer 1 more required question"
        : `Answer ${missingRequired} more required questions`;
  } else if (invalidOptional > 0) {
    blockedReason = invalidOptional === 1 ? "Fix 1 answer" : `Fix ${invalidOptional} answers`;
  }
  return {
    answered,
    total: questions.length,
    missingRequired,
    invalidOptional,
    blockedReason,
    rejects,
  };
}

/** "1 hour", "90 minutes" → "1 hour 30 minutes", "2 days". */
export function humanizeSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const units: [number, string][] = [
    [86_400, "day"],
    [3_600, "hour"],
    [60, "minute"],
    [1, "second"],
  ];
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, name] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) {
      parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
      rest -= count * size;
    }
    if (parts.length === 2) break;
  }
  return parts.length ? parts.join(" ") : "0 seconds";
}

/** Compact remaining time for a live countdown: "58m left", "2h 5m left", "40s left". */
export function formatRemaining(ms: number): string {
  if (ms <= 0) return "expiring";
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) return `${days}d ${hours % 24}h left`;
  if (hours > 0) return `${hours}h ${minutes % 60}m left`;
  if (minutes > 0) return `${minutes}m left`;
  return `${seconds}s left`;
}

/**
 * "Needs approval from Taras" / "Needs 2 of: a, b, c" / "Anyone can answer".
 * `nameFor` maps a stored approver (user id or email) to a display name;
 * unresolved entries show as stored.
 */
export function describeApprovers(
  approvers: ApprovalRequest["approvers"] | null | undefined,
  nameFor: (idOrEmail: string) => string | undefined = () => undefined,
): string {
  const people = [
    ...(approvers?.users ?? []).map((u) => nameFor(u) ?? u),
    ...(approvers?.roles ?? []).map((r) => `@${r}`),
  ];
  const policy = approvers?.policy ?? "any";
  if (people.length === 0) return "Anyone on the team can answer";
  const list = people.join(", ");
  if (typeof policy === "object") return `Needs ${policy.min} of ${people.length}: ${list}`;
  if (people.length === 1) return `Needs an answer from ${list}`;
  return policy === "all" ? `Needs every approver: ${list}` : `Any one of ${list} can answer`;
}

/** Workflow / agent / manual, for list rows and the header meta line. */
export function approvalRequestSource(
  request: Pick<ApprovalRequest, "workflowRunId" | "sourceTaskId">,
): "workflow" | "agent" | "manual" {
  if (request.workflowRunId) return "workflow";
  if (request.sourceTaskId) return "agent";
  return "manual";
}

/** Pending first (oldest pending on top: it expires first), then newest resolved. */
export function sortApprovalRequests<T extends Pick<ApprovalRequest, "status" | "createdAt">>(
  requests: readonly T[],
): T[] {
  return [...requests].sort((a, b) => {
    const aPending = a.status === "pending" ? 0 : 1;
    const bPending = b.status === "pending" ? 0 : 1;
    if (aPending !== bPending) return aPending - bPending;
    const diff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
    return aPending === 0 ? diff : -diff;
  });
}
