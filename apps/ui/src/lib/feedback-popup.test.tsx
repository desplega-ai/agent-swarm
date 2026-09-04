import { describe, expect, test } from "bun:test";
import { shouldShowFeedbackPopup } from "./feedback-popup";
import { isAdminLike } from "./user-role";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

const eligible = {
  isCloud: false,
  currentUserState: "ready" as const,
  user: { role: "admin" },
  dismissed: false,
  installedAt: daysAgo(8),
  hasFailedTask: false,
  otherDialogOpen: false,
  nowMs: NOW,
};

describe("isAdminLike", () => {
  test("treats missing and empty roles as admin during onboarding", () => {
    expect(isAdminLike({})).toBe(true);
    expect(isAdminLike({ role: "  " })).toBe(true);
    expect(isAdminLike({ role: "admin" })).toBe(true);
  });

  test("rejects an explicit non-admin role", () => {
    expect(isAdminLike({ role: "member" })).toBe(false);
  });
});

describe("shouldShowFeedbackPopup", () => {
  test("shows from day seven through day twenty-nine", () => {
    expect(shouldShowFeedbackPopup(eligible)).toBe(true);
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: daysAgo(7) })).toBe(true);
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: daysAgo(30) })).toBe(false);
  });

  test("shows before day seven after a failure", () => {
    expect(
      shouldShowFeedbackPopup({ ...eligible, installedAt: daysAgo(2), hasFailedTask: true }),
    ).toBe(true);
  });

  test("allows only the failure trigger when install age is unknown", () => {
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: null })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, installedAt: null, hasFailedTask: true })).toBe(
      true,
    );
  });

  test("waits for identity and any other dialog to close", () => {
    expect(shouldShowFeedbackPopup({ ...eligible, currentUserState: "pending" })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, otherDialogOpen: true })).toBe(false);
  });

  test("never shows on cloud, after dismissal, or to an explicit non-admin", () => {
    expect(shouldShowFeedbackPopup({ ...eligible, isCloud: true })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, dismissed: true })).toBe(false);
    expect(shouldShowFeedbackPopup({ ...eligible, user: { role: "viewer" } })).toBe(false);
  });
});
