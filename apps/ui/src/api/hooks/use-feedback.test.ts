import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { FeedbackInput, StatusResponse } from "@/api/types";

let statusData: StatusResponse | null | undefined;
let configs: Array<{ key: string; value: string }> = [];
const sent: Array<{ endpoint: string; input: FeedbackInput }> = [];

mock.module("@tanstack/react-query", () => ({
  // The options are enough here: the test calls `mutationFn` itself.
  useMutation: (options: unknown) => options,
}));
mock.module("../client", () => ({
  api: {
    submitFeedback: async (endpoint: string, input: FeedbackInput) => {
      sent.push({ endpoint, input });
    },
  },
}));
mock.module("@/api/client", () => ({ api: {} }));
mock.module("@/api/hooks/use-config-api", () => ({
  useConfigs: () => ({ data: configs }),
}));
mock.module("@/api/hooks/use-ui-telemetry", () => require("./use-ui-telemetry"));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: statusData }),
}));

const { useSubmitFeedback } = await import("./use-feedback");

const INPUT: FeedbackInput = {
  submission_id: "submission-1",
  user_id: "user-1",
  swarm_version: "test",
  newsletter_consent: false,
  submitted_at: "2026-10-19T00:00:00.000Z",
};

/** The mocked `useMutation` returns its options. */
const send = (mutation: unknown) =>
  (mutation as { mutationFn: (input: FeedbackInput) => Promise<void> }).mutationFn(INPUT);

function telemetry(enabled: boolean): StatusResponse {
  return { telemetry: { enabled } } as StatusResponse;
}

beforeEach(() => {
  statusData = telemetry(true);
  configs = [
    { key: "telemetry_installation_id", value: "install-1" },
    { key: "telemetry_installed_at", value: "2026-01-01T00:00:00.000Z" },
  ];
  sent.length = 0;
});

describe("useSubmitFeedback", () => {
  test("posts to Desplega's proxy without a feedback_endpoint override", async () => {
    await send(useSubmitFeedback());
    expect(sent[0]?.endpoint).toBe("https://proxy.desplega.sh/v1/feedback");
  });

  test("posts to the feedback_endpoint global config key when it is set", async () => {
    configs.push({ key: "feedback_endpoint", value: " http://localhost:4999/v1/feedback " });
    await send(useSubmitFeedback());
    expect(sent[0]?.endpoint).toBe("http://localhost:4999/v1/feedback");
  });

  test("adds install_id and installed_at while telemetry is on", async () => {
    await send(useSubmitFeedback());
    expect(sent[0]?.input).toEqual({
      ...INPUT,
      install_id: "install-1",
      installed_at: "2026-01-01T00:00:00.000Z",
    });
  });

  test("leaves install_id and installed_at out while telemetry is off", async () => {
    statusData = telemetry(false);
    await send(useSubmitFeedback());
    expect(sent[0]?.input).toEqual(INPUT);
  });

  test("leaves them out while /status loads", async () => {
    statusData = undefined;
    await send(useSubmitFeedback());
    expect(sent[0]?.input).not.toHaveProperty("install_id");
  });

  test("leaves them out when the install has no ID", async () => {
    configs = [];
    await send(useSubmitFeedback());
    expect(sent[0]?.input).toEqual(INPUT);
  });
});
