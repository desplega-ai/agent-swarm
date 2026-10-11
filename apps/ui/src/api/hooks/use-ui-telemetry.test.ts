import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { StatusResponse } from "@/api/types";

const sent: Array<{ event: string; properties: Record<string, unknown> }> = [];
mock.module("@/api/client", () => ({
  api: {
    sendUiEvent: async (event: string, properties: Record<string, unknown>) => {
      sent.push({ event, properties });
    },
  },
}));
mock.module("@/app/status-context", () => ({ useStatusContext: () => ({ data: undefined }) }));

const { isUiTelemetryEnabled, sendUiTelemetry } = await import("./use-ui-telemetry");

const status = (telemetry?: { enabled: boolean }) =>
  ({ identity: { name: "Acme" }, ...(telemetry ? { telemetry } : {}) }) as StatusResponse;

const shown = {
  event: "popup.shown",
  properties: { popup: "feedback", trigger: "quarterly" },
} as const;

beforeEach(() => {
  sent.length = 0;
});

describe("sendUiTelemetry", () => {
  test("sends nothing while /status is loading", () => {
    expect(isUiTelemetryEnabled(undefined)).toBe(false);
    sendUiTelemetry(undefined, shown);
    expect(sent).toEqual([]);
  });

  test("sends nothing when telemetry is off", () => {
    sendUiTelemetry(status({ enabled: false }), shown);
    expect(sent).toEqual([]);
  });

  test("sends when telemetry is on, dropping undefined optional properties", () => {
    sendUiTelemetry(status({ enabled: true }), shown);
    sendUiTelemetry(status({ enabled: true }), {
      event: "notification.submitted",
      properties: { key: "slack-connect-invite", email_domain: undefined },
    });
    expect(sent).toEqual([
      { event: "popup.shown", properties: { popup: "feedback", trigger: "quarterly" } },
      { event: "notification.submitted", properties: { key: "slack-connect-invite" } },
    ]);
  });

  test("an older server without the telemetry field counts as on", () => {
    sendUiTelemetry(status(), shown);
    sendUiTelemetry(null, shown);
    expect(sent).toHaveLength(2);
  });
});
