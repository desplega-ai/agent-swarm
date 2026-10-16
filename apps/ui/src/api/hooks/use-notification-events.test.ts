import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StatusResponse } from "@/api/types";

// `__APP_VERSION__` is a Vite define; the hook reads it when it builds a payload.
(globalThis as { __APP_VERSION__?: string }).__APP_VERSION__ = "test";

type Feedback = {
  message?: string;
  email?: string;
  submission_id?: string;
  install_id?: string;
  installed_at?: string | null;
};

let statusData: StatusResponse | null | undefined;
let userId: string | null;
const submitted: Feedback[] = [];
const events: Array<{ event: string; properties: Record<string, unknown> }> = [];

const globalConfigs = [
  { key: "telemetry_installation_id", value: "install-1" },
  { key: "telemetry_installed_at", value: "2026-01-01T00:00:00.000Z" },
];
mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({ data: globalConfigs }),
}));
mock.module("@/api/hooks/use-feedback", () => ({
  useSubmitFeedback: () => ({ mutate: (input: Feedback) => submitted.push(input) }),
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
    trackEvent("slack-connect-invite", "submit", "acme.com");

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
    trackEvent("slack-connect-invite", "submit", "acme.com");

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

  test("notifyUs is a user-typed submission and stays ungated", () => {
    statusData = status({ enabled: false });
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]?.email).toBe("me@acme.com");
    expect(submitted[0]?.message).toContain("[notification] key=slack-connect-invite");
    expect(events).toEqual([]);
  });

  test("notifyUs carries install_id and installed_at while telemetry is on", () => {
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com");

    expect(submitted[0]?.install_id).toBe("install-1");
    expect(submitted[0]?.installed_at).toBe("2026-01-01T00:00:00.000Z");
  });

  test("notifyUs omits install_id and installed_at while telemetry is off", () => {
    statusData = status({ enabled: false });
    useNotificationEvents().notifyUs("slack-connect-invite", "please invite me", "me@acme.com");

    expect(submitted).toHaveLength(1);
    expect(submitted[0]).not.toHaveProperty("install_id");
    expect(submitted[0]).not.toHaveProperty("installed_at");
  });
});
