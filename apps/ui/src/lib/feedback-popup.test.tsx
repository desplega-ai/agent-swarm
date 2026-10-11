import {
  EMPTY_FEEDBACK_POPUP_STATE,
  FEEDBACK_DISMISS_COOLDOWN_MS,
  FEEDBACK_SUBMISSION_COOLDOWN_MS,
  feedbackPopupStorageKey,
  feedbackPopupTrigger,
  followUpQuestion,
  parseFeedbackPopupState,
} from "./feedback-popup";
import { isAdminLike } from "./user-role";

const NOW = Date.parse("2026-09-03T12:00:00.000Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString();

/** Eligible in every respect, but no trigger holds yet. */
const base = {
  isCloud: false,
  currentUserState: "ready" as const,
  user: { role: "admin" },
  state: EMPTY_FEEDBACK_POPUP_STATE,
  installedAt: daysAgo(8),
  tasksCompleted: 0,
  tasksFailed: 0,
  workflowRunsCompleted: 0,
  sessionId: "session-2",
  otherDialogOpen: false,
  nowMs: NOW,
};
/** Eligible with the workflow trigger. */
const eligible = { ...base, workflowRunsCompleted: 1 };

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

describe("feedbackPopupTrigger", () => {
  test("no trigger, no card", () => {
    expect(feedbackPopupTrigger(base)).toBeNull();
  });

  test("task_failed waits for a later session than the first failure", () => {
    const seen = { ...EMPTY_FEEDBACK_POPUP_STATE, firstFailureSessionId: "session-1" };
    expect(feedbackPopupTrigger({ ...base, tasksFailed: 1 })).toBeNull();
    expect(
      feedbackPopupTrigger({
        ...base,
        tasksFailed: 1,
        state: { ...seen, firstFailureSessionId: "session-2" },
      }),
    ).toBeNull();
    expect(feedbackPopupTrigger({ ...base, tasksFailed: 1, state: seen })).toBe("task_failed");
  });

  test("workflow_completed after one completed workflow run", () => {
    expect(feedbackPopupTrigger(eligible)).toBe("workflow_completed");
  });

  test("tasks_completed needs 10 tasks and an install at least 3 days old", () => {
    expect(feedbackPopupTrigger({ ...base, tasksCompleted: 10 })).toBe("tasks_completed");
    expect(feedbackPopupTrigger({ ...base, tasksCompleted: 9 })).toBeNull();
    expect(
      feedbackPopupTrigger({ ...base, tasksCompleted: 10, installedAt: daysAgo(2) }),
    ).toBeNull();
  });

  test("quarterly asks a 200-day-old install that was never asked", () => {
    expect(feedbackPopupTrigger({ ...base, installedAt: daysAgo(200) })).toBe("quarterly");
  });

  test("quarterly waits 90 days after the last ask", () => {
    const state = { ...EMPTY_FEEDBACK_POPUP_STATE, lastShownAt: daysAgo(89) };
    expect(feedbackPopupTrigger({ ...base, installedAt: daysAgo(200), state })).toBeNull();
    expect(
      feedbackPopupTrigger({
        ...base,
        installedAt: daysAgo(200),
        state: { ...state, lastShownAt: daysAgo(90) },
      }),
    ).toBe("quarterly");
  });

  test("event triggers fire only before the first ask", () => {
    const asked = { ...EMPTY_FEEDBACK_POPUP_STATE, lastShownAt: daysAgo(40) };
    expect(feedbackPopupTrigger({ ...eligible, state: asked })).toBeNull();
  });

  test("an unknown install date blocks only the age-based triggers", () => {
    expect(feedbackPopupTrigger({ ...base, installedAt: null, tasksCompleted: 50 })).toBeNull();
    expect(feedbackPopupTrigger({ ...eligible, installedAt: null })).toBe("workflow_completed");
  });

  test("waits for identity and any other dialog to close", () => {
    expect(feedbackPopupTrigger({ ...eligible, currentUserState: "pending" })).toBeNull();
    expect(feedbackPopupTrigger({ ...eligible, otherDialogOpen: true })).toBeNull();
  });

  test("never shows on cloud or to an explicit non-admin", () => {
    expect(feedbackPopupTrigger({ ...eligible, isCloud: true })).toBeNull();
    expect(feedbackPopupTrigger({ ...eligible, user: { role: "viewer" } })).toBeNull();
  });

  test("never prompts twice inside the submission cooldown", () => {
    const at = (ms: number) => ({
      ...EMPTY_FEEDBACK_POPUP_STATE,
      lastSubmittedAt: new Date(NOW - ms).toISOString(),
      submissionCount: 1,
    });
    const old = { ...base, installedAt: daysAgo(400) };
    expect(
      feedbackPopupTrigger({ ...old, state: at(FEEDBACK_SUBMISSION_COOLDOWN_MS - 1) }),
    ).toBeNull();
    expect(feedbackPopupTrigger({ ...old, state: at(FEEDBACK_SUBMISSION_COOLDOWN_MS) })).toBe(
      "quarterly",
    );
  });

  test("suppresses a dismissal for the shorter cooldown", () => {
    const at = (ms: number) => ({
      ...EMPTY_FEEDBACK_POPUP_STATE,
      lastDismissedAt: new Date(NOW - ms).toISOString(),
    });
    expect(
      feedbackPopupTrigger({ ...eligible, state: at(FEEDBACK_DISMISS_COOLDOWN_MS - 1) }),
    ).toBeNull();
    expect(feedbackPopupTrigger({ ...eligible, state: at(FEEDBACK_DISMISS_COOLDOWN_MS) })).toBe(
      "workflow_completed",
    );
  });

  test("treats a future stored timestamp conservatively", () => {
    expect(
      feedbackPopupTrigger({
        ...eligible,
        state: {
          ...EMPTY_FEEDBACK_POPUP_STATE,
          lastSubmittedAt: new Date(NOW + 24 * 60 * 60 * 1000).toISOString(),
          submissionCount: 1,
        },
      }),
    ).toBeNull();
  });
});

describe("followUpQuestion", () => {
  test("asks detractors, passives and promoters different questions", () => {
    expect(followUpQuestion(0)).toBe("What almost made you give up?");
    expect(followUpQuestion(6)).toBe("What almost made you give up?");
    expect(followUpQuestion(7)).toBe("What would make it a 10?");
    expect(followUpQuestion(8)).toBe("What would make it a 10?");
    expect(followUpQuestion(9)).toBe("What would you tell a colleague?");
  });
});

describe("feedback popup storage", () => {
  test("uses one versioned deployment-and-user key", () => {
    expect(feedbackPopupStorageKey("https://swarm.example", "user_1")).toBe(
      "swarm:feedback-popup:v1:https://swarm.example:user_1",
    );
  });

  test("parses valid state and safely resets malformed state", () => {
    expect(
      parseFeedbackPopupState(
        JSON.stringify({
          version: 1,
          lastSubmittedAt: "2026-09-01T00:00:00.000Z",
          lastDismissedAt: null,
          submissionCount: 2,
        }),
      ),
    ).toEqual({
      ...EMPTY_FEEDBACK_POPUP_STATE,
      lastSubmittedAt: "2026-09-01T00:00:00.000Z",
      submissionCount: 2,
    });
    expect(parseFeedbackPopupState("not-json")).toEqual(EMPTY_FEEDBACK_POPUP_STATE);
    expect(parseFeedbackPopupState(JSON.stringify({ version: 2 }))).toEqual(
      EMPTY_FEEDBACK_POPUP_STATE,
    );
  });
});

describe("prompt coordination", () => {
  test("remembers the prompt for this load and scopes it to the connection", async () => {
    const { markPromptShownThisLoad, promptShownThisLoad } = await import(
      "../hooks/use-other-dialog-open"
    );
    const apiUrl = "https://prompt-coordination.example";
    expect(promptShownThisLoad(apiUrl)).toBe(false);
    markPromptShownThisLoad(apiUrl);
    expect(promptShownThisLoad(apiUrl)).toBe(true);
    expect(promptShownThisLoad("https://other.example")).toBe(false);
  });
});
