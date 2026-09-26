import { describe, expect, test } from "bun:test";
import type { ApprovalQuestion } from "../api/types";
import {
  answerHint,
  answerProgress,
  approverParts,
  describeApprovers,
  formatApprovalAnswer,
  formatRemaining,
  humanizeSeconds,
  sortApprovalRequests,
} from "./approval-format";

const approve: ApprovalQuestion = { id: "go", type: "approval", label: "Ship it?", required: true };
const yesNo: ApprovalQuestion = { id: "yn", type: "boolean", label: "Continue?", required: true };
const single: ApprovalQuestion = {
  id: "env",
  type: "single-select",
  label: "Where?",
  required: true,
  options: [
    { value: "stg", label: "Staging" },
    { value: "prod", label: "Production" },
  ],
};
const multi: ApprovalQuestion = {
  id: "checks",
  type: "multi-select",
  label: "Which checks?",
  required: true,
  minSelections: 2,
  maxSelections: 3,
  options: [
    { value: "lint", label: "Lint" },
    { value: "tsc", label: "Typecheck" },
    { value: "test", label: "Tests" },
    { value: "e2e", label: "E2E" },
  ],
};
const text: ApprovalQuestion = { id: "why", type: "text", label: "Why?", multiline: true };

describe("formatApprovalAnswer", () => {
  test("approval renders a decision word with its tone, never JSON", () => {
    expect(formatApprovalAnswer(approve, { approved: true })).toEqual({
      kind: "decision",
      tone: "success",
      text: "Approved",
      note: undefined,
    });
    expect(formatApprovalAnswer(approve, { approved: false, comment: " too risky " })).toEqual({
      kind: "decision",
      tone: "error",
      text: "Rejected",
      note: "too risky",
    });
  });

  test("boolean renders Yes / No", () => {
    expect(formatApprovalAnswer(yesNo, true).text).toBe("Yes");
    expect(formatApprovalAnswer(yesNo, false).text).toBe("No");
  });

  test("single-select renders the option label, falling back to the value", () => {
    expect(formatApprovalAnswer(single, "prod")).toMatchObject({
      kind: "choice",
      text: "Production",
    });
    expect(formatApprovalAnswer(single, "qa")).toMatchObject({ kind: "choice", text: "qa" });
  });

  test("multi-select renders one label per pick", () => {
    expect(formatApprovalAnswer(multi, ["lint", "test"])).toMatchObject({
      kind: "choices",
      text: "Lint, Tests",
      items: ["Lint", "Tests"],
    });
    expect(formatApprovalAnswer(multi, [])).toMatchObject({ kind: "empty", text: "None selected" });
  });

  test("text renders the string as-is; blank or missing is 'No answer'", () => {
    expect(formatApprovalAnswer(text, "Looks good\nship")).toMatchObject({
      kind: "text",
      text: "Looks good\nship",
    });
    expect(formatApprovalAnswer(text, "   ").kind).toBe("empty");
    expect(formatApprovalAnswer(text, undefined).text).toBe("No answer");
    expect(formatApprovalAnswer(approve, null).kind).toBe("empty");
  });

  test("a response of the wrong shape falls back to raw JSON", () => {
    expect(formatApprovalAnswer(approve, "yes")).toEqual({
      kind: "raw",
      tone: "neutral",
      text: '"yes"',
    });
    expect(formatApprovalAnswer(multi, "lint").kind).toBe("raw");
  });
});

describe("answerHint and answerProgress", () => {
  test("hints say what is missing", () => {
    expect(answerHint(approve, undefined)).toBe("Approve or reject to continue");
    expect(answerHint(multi, ["lint"])).toBe("Pick at least 2");
    expect(answerHint(multi, ["lint", "tsc", "test", "e2e"])).toBe("Pick at most 3");
    expect(answerHint(multi, ["lint", "tsc"])).toBeNull();
    // Optional and untouched: nothing to say.
    expect(answerHint(text, undefined)).toBeNull();
  });

  test("progress counts answers and explains a blocked submit", () => {
    const questions = [approve, single, text];
    expect(answerProgress(questions, {})).toMatchObject({
      answered: 0,
      total: 3,
      blockedReason: "Answer 2 more required questions",
      rejects: false,
    });
    expect(answerProgress(questions, { go: { approved: false }, env: "stg" })).toMatchObject({
      answered: 2,
      blockedReason: null,
      rejects: true,
    });
  });
});

describe("time, approvers and ordering", () => {
  test("humanizes seconds and remaining time", () => {
    expect(humanizeSeconds(3600)).toBe("1 hour");
    expect(humanizeSeconds(5400)).toBe("1 hour 30 minutes");
    expect(humanizeSeconds(172_800)).toBe("2 days");
    expect(formatRemaining(58 * 60_000 + 5_000)).toBe("58m left");
    expect(formatRemaining(0)).toBe("expiring");
  });

  test("describes the approver policy", () => {
    expect(describeApprovers({ policy: "any" })).toBe("Anyone on the team can answer");
    expect(describeApprovers({ users: ["t@desplega.ai"], policy: "any" })).toBe(
      "Needs an answer from t@desplega.ai",
    );
    expect(describeApprovers({ users: ["a", "b", "c"], policy: { min: 2 } })).toBe(
      "Needs 2 of 3: a, b, c",
    );
    const names: Record<string, string> = { "4dacc65c": "Taras" };
    expect(describeApprovers({ users: ["4dacc65c"], policy: "any" }, (id) => names[id])).toBe(
      "Needs an answer from Taras",
    );
    expect(
      describeApprovers({ users: ["4dacc65c", "unknown"], policy: "all" }, (id) => names[id]),
    ).toBe("Needs every approver: Taras, unknown");
  });

  test("approverParts splits the sentence from the people, for chips", () => {
    expect(approverParts({ users: ["u1"], policy: "any" })).toEqual({
      lead: "Needs an answer from",
      people: [{ kind: "user", ref: "u1" }],
      tail: "",
    });
    expect(approverParts({ users: ["u1"], roles: ["ops"], policy: "any" })).toEqual({
      lead: "Any one of",
      people: [
        { kind: "user", ref: "u1" },
        { kind: "role", role: "ops" },
      ],
      tail: "can answer",
    });
    expect(approverParts(null)).toEqual({
      lead: "Anyone on the team can answer",
      people: [],
      tail: "",
    });
  });

  test("sorts live deadlines soonest first, then no deadline, then overdue, then resolved", () => {
    const now = Date.parse("2026-09-26T10:00:00Z");
    const rows = [
      { id: "r-old", status: "approved" as const, createdAt: "2026-09-20T10:00:00Z" },
      { id: "p-new", status: "pending" as const, createdAt: "2026-09-24T10:00:00Z" },
      { id: "r-new", status: "rejected" as const, createdAt: "2026-09-23T10:00:00Z" },
      {
        id: "p-march-overdue",
        status: "pending" as const,
        createdAt: "2026-03-02T10:00:00Z",
        expiresAt: "2026-03-03T10:00:00Z",
      },
      {
        id: "p-july-overdue",
        status: "pending" as const,
        createdAt: "2026-07-15T10:00:00Z",
        expiresAt: "2026-07-22T10:00:00Z",
      },
      {
        id: "p-expires-late",
        status: "pending" as const,
        createdAt: "2026-09-01T10:00:00Z",
        expiresAt: "2026-09-30T10:00:00Z",
      },
      {
        id: "p-expires-soon",
        status: "pending" as const,
        createdAt: "2026-09-02T10:00:00Z",
        expiresAt: "2026-09-26T12:00:00Z",
      },
    ];
    expect(sortApprovalRequests(rows, now).map((r) => r.id)).toEqual([
      "p-expires-soon",
      "p-expires-late",
      "p-new",
      "p-july-overdue",
      "p-march-overdue",
      "r-new",
      "r-old",
    ]);
  });
});
