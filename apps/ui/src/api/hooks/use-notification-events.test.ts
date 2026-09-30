import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StatusResponse } from "@/api/types";

// `__APP_VERSION__` is a Vite define; the hook reads it when it builds a payload.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "test";

type Feedback = { message?: string; email?: string };

let statusData: StatusResponse | null | undefined;
let userId: string | null;
const submitted: Feedback[] = [];

mock.module("@/api/hooks/use-config-api", () => ({ useConfigs: () => ({ data: [] }) }));
mock.module("@/api/hooks/use-feedback", () => ({
  useSubmitFeedback: () => ({ mutate: (input: Feedback) => submitted.push(input) }),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: statusData, isLoading: false, error: null }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId }),
}));

const { isEventTrackingEnabled, useNotificationEvents } = await import("./use-notification-events");

function status(telemetry?: { enabled: boolean }): StatusResponse {
  return {
    identity: { name: "Acme" },
    ...(telemetry ? { telemetry } : {}),
  } as StatusResponse;
}

beforeEach(() => {
  statusData = status({ enabled: true });
  userId = "user-1";
  submitted.length = 0;
});

describe("isEventTrackingEnabled", () => {
  test("is on when the server reports telemetry enabled", () => {
    expect(isEventTrackingEnabled(status({ enabled: true }))).toBe(true);
  });

  test("is off when the server reports telemetry disabled", () => {
    expect(isEventTrackingEnabled(status({ enabled: false }))).toBe(false);
  });

  test("treats a payload without the field (older server) as enabled", () => {
    expect(isEventTrackingEnabled(status())).toBe(true);
  });

  test("treats a missing /status endpoint (null) as enabled", () => {
    expect(isEventTrackingEnabled(null)).toBe(true);
  });

  test("holds events back until /status has resolved", () => {
    expect(isEventTrackingEnabled(undefined)).toBe(false);
  });
});

describe("useNotificationEvents", () => {
  test("trackEvent posts view, dismiss and submit events when telemetry is on", () => {
    const { trackEvent } = useNotificationEvents();
    trackEvent("slack-connect-invite", "view");
    trackEvent("slack-connect-invite", "dismiss");
    trackEvent("slack-connect-invite", "submit", "acme.com");

    expect(submitted.map((entry) => entry.message)).toEqual([
      "[notification_event] key=slack-connect-invite action=view",
      "[notification_event] key=slack-connect-invite action=dismiss",
      "[notification_event] key=slack-connect-invite action=submit domain=acme.com",
    ]);
  });

  test("trackEvent sends nothing when the operator opted out", () => {
    statusData = status({ enabled: false });
    const { trackEvent } = useNotificationEvents();
    trackEvent("slack-connect-invite", "view");
    trackEvent("slack-connect-invite", "dismiss");
    trackEvent("slack-connect-invite", "submit", "acme.com");
    trackEvent("slack-connect-invite", "already_have_one");

    expect(submitted).toEqual([]);
  });

  test("trackEvent still sends against an older server that omits the field", () => {
    statusData = status();
    useNotificationEvents().trackEvent("slack-connect-invite", "view");
    expect(submitted).toHaveLength(1);
  });

  test("notifyUs is a user-typed submission and stays ungated", () => {
    statusData = status({ enabled: false });
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.email).toBe("me@acme.com");
    expect(submitted[0]?.message).toContain("[notification] key=slack-connect-invite");
  });
});
