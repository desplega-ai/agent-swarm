import { describe, expect, test } from "bun:test";
import type { ApprovalQuestion, ApprovalRequest, User } from "../api/types";
import { canAnswerInline, type InlineViewer } from "./approval-inline";

type Req = Parameters<typeof canAnswerInline>[0];

const APPROVE: ApprovalQuestion = { id: "q1", type: "approval", label: "Ship it?" };

function request(overrides: Partial<ApprovalRequest> = {}): Req {
  return {
    status: "pending",
    questions: [APPROVE],
    approvers: { policy: "any" },
    approvals: [],
    expiresAt: null,
    ...overrides,
  };
}

function user(overrides: Partial<User> = {}): InlineViewer {
  return {
    kind: "user",
    user: {
      id: "u-taras",
      name: "Taras",
      email: "t@example.com",
      role: "admin",
      emailAliases: [],
      preferredChannel: "slack",
      ...overrides,
    },
  };
}

const OPERATOR: InlineViewer = { kind: "operator" };
const NOW = Date.parse("2026-11-07T12:00:00Z");

describe("canAnswerInline", () => {
  test("open request with no listed approvers: any known person answers inline", () => {
    expect(canAnswerInline(request(), user(), true, NOW)).toBe(true);
    expect(canAnswerInline(request(), OPERATOR, true, NOW)).toBe(true);
  });

  test("link only while the viewer is unknown or the role cannot respond", () => {
    expect(canAnswerInline(request(), null, true, NOW)).toBe(false);
    expect(canAnswerInline(request(), user(), false, NOW)).toBe(false);
  });

  test("link only once resolved or past the deadline", () => {
    expect(canAnswerInline(request({ status: "approved" }), user(), true, NOW)).toBe(false);
    const expired = request({ expiresAt: "2026-11-07T11:59:59Z" });
    expect(canAnswerInline(expired, user(), true, NOW)).toBe(false);
    const open = request({ expiresAt: "2026-11-07T12:30:00Z" });
    expect(canAnswerInline(open, user(), true, NOW)).toBe(true);
  });

  test("listed users match by id or case-insensitive email", () => {
    const byId = request({ approvers: { users: ["u-taras"], policy: "any" } });
    const byEmail = request({ approvers: { users: ["T@Example.com"], policy: "any" } });
    const other = request({ approvers: { users: ["u-eze"], policy: "any" } });
    expect(canAnswerInline(byId, user(), true, NOW)).toBe(true);
    expect(canAnswerInline(byEmail, user(), true, NOW)).toBe(true);
    expect(canAnswerInline(other, user(), true, NOW)).toBe(false);
  });

  test("listed roles match the user's role", () => {
    const admins = request({ approvers: { roles: ["admin"], policy: "any" } });
    expect(canAnswerInline(admins, user(), true, NOW)).toBe(true);
    expect(canAnswerInline(admins, user({ role: "requester" }), true, NOW)).toBe(false);
    expect(canAnswerInline(admins, user({ role: undefined }), true, NOW)).toBe(false);
  });

  test("the operator key never answers inline for listed approvers", () => {
    const listed = request({ approvers: { users: ["u-taras"], roles: ["admin"], policy: "any" } });
    expect(canAnswerInline(listed, OPERATOR, true, NOW)).toBe(false);
  });

  test("policy all with listed users: only a listed user, whose vote counts", () => {
    const all = request({ approvers: { users: ["u-eze"], roles: ["admin"], policy: "all" } });
    expect(canAnswerInline(all, user(), true, NOW)).toBe(false);
    expect(canAnswerInline(all, user({ id: "u-eze", email: "e@example.com" }), true, NOW)).toBe(
      true,
    );
  });

  test("a viewer who already voted on a quorum request gets the link only", () => {
    const vote = { responder: "u-taras", approved: true, responses: {}, respondedAt: "x" };
    const min2 = request({ approvers: { policy: { min: 2 } }, approvals: [vote] });
    expect(canAnswerInline(min2, user(), true, NOW)).toBe(false);
    expect(canAnswerInline(min2, user({ id: "u-eze", email: "e@example.com" }), true, NOW)).toBe(
      true,
    );
    const operatorVote = request({
      approvers: { policy: { min: 2 } },
      approvals: [{ ...vote, responder: "operator" }],
    });
    expect(canAnswerInline(operatorVote, OPERATOR, true, NOW)).toBe(false);
  });

  test("every question type must render inline: a config question sends to the page", () => {
    const types: ApprovalQuestion["type"][] = [
      "approval",
      "boolean",
      "single-select",
      "multi-select",
      "text",
    ];
    const all = types.map((type, i) => ({ id: `q${i}`, type, label: type }));
    expect(canAnswerInline(request({ questions: all }), user(), true, NOW)).toBe(true);
    const withConfig = request({
      questions: [APPROVE, { id: "c", type: "config", label: "Key" }],
    });
    expect(canAnswerInline(withConfig, user(), true, NOW)).toBe(false);
    expect(canAnswerInline(request({ questions: [] }), user(), true, NOW)).toBe(false);
  });
});
