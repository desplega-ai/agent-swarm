import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StatusResponse } from "@/api/types";

// `__APP_VERSION__` is a Vite define; the hook reads it when it builds a payload.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "test";

type Feedback = {
  message?: string;
  email?: string;
  submission_id?: string;
  org_name?: string;
};

let statusData: StatusResponse | null | undefined;
let userId: string | null;
const submitted: Feedback[] = [];
const events: Array<{ event: string; properties: Record<string, unknown> }> = [];

mock.module("@/api/hooks/use-feedback", () => ({
  useSubmitFeedback: () => ({
    mutateAsync: async (input: Feedback) => {
      submitted.push(input);
    },
  }),
}));
mock.module("@/api/client", () => ({
  api: {
    sendUiEvent: async (event: string, properties: Record<string, unknown>) => {
      events.push({ event, properties });
    },
  },
}));
mock.module("@/api/hooks/use-ui-telemetry", () => require("./use-ui-telemetry"));
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
  events.length = 0;
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
  test("trackEvent sends notification.* events, never through /v1/feedback", () => {
    const { trackEvent } = useNotificationEvents();
    trackEvent("slack-connect-invite", "view");
    trackEvent("slack-connect-invite", "dismiss");
    trackEvent("slack-connect-invite", "submit", { email_domain: "acme.com" });

    expect(events).toEqual([
      { event: "notification.viewed", properties: { key: "slack-connect-invite" } },
      { event: "notification.dismissed", properties: { key: "slack-connect-invite" } },
      {
        event: "notification.submitted",
        properties: { key: "slack-connect-invite", email_domain: "acme.com" },
      },
    ]);
    expect(submitted).toEqual([]);
  });

  test("trackEvent sends nothing when the operator opted out", () => {
    statusData = status({ enabled: false });
    const { trackEvent } = useNotificationEvents();
    trackEvent("slack-connect-invite", "view");
    trackEvent("slack-connect-invite", "dismiss");
    trackEvent("slack-connect-invite", "submit", { email_domain: "acme.com" });

    expect(events).toEqual([]);
  });

  test("trackEvent sends nothing while /status is loading", () => {
    statusData = undefined;
    useNotificationEvents().trackEvent("slack-connect-invite", "view");
    expect(events).toEqual([]);
  });

  test("trackEvent still sends against an older server that omits the field", () => {
    statusData = status();
    useNotificationEvents().trackEvent("slack-connect-invite", "view");
    expect(events).toHaveLength(1);
  });

  test("notifyUs sends the email to /v1/feedback and no telemetry event", () => {
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.email).toBe("me@acme.com");
    expect(typeof submitted[0]?.submission_id).toBe("string");
    expect(events).toEqual([]);
  });

  test("notifyUs prefers an explicit org_name over the last /status name", () => {
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com", {
      org_name: "Acme",
    });

    expect(submitted[0]?.org_name).toBe("Acme");
  });

  test("notifyUs is a user-typed submission and stays ungated", () => {
    statusData = status({ enabled: false });
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.email).toBe("me@acme.com");
    expect(submitted[0]?.message).toContain("[notification] key=slack-connect-invite");
    expect(events).toEqual([]);
  });
});
