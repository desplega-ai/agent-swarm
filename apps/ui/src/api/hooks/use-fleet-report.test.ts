import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { FeedbackInput } from "@/api/types";

const sent: FeedbackInput[] = [];
let userId: string | null = "user-1";

mock.module("@/api/hooks/use-feedback", () => ({
  useSubmitFeedback: () => ({
    mutateAsync: async (input: FeedbackInput) => {
      sent.push(input);
    },
  }),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: { identity: { name: "Test swarm" } } }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId }),
}));

const { useSubscribeFleetReport } = await import("./use-fleet-report");
const originalCrypto = crypto;
const cryptoDescriptor = Object.getOwnPropertyDescriptor(globalThis, "crypto");
const appVersion = Object.getOwnPropertyDescriptor(globalThis, "__APP_VERSION__");

beforeEach(() => {
  sent.length = 0;
  userId = "user-1";
  Object.defineProperty(globalThis, "__APP_VERSION__", { configurable: true, value: "test" });
});

afterEach(() => {
  if (cryptoDescriptor) Object.defineProperty(globalThis, "crypto", cryptoDescriptor);
  if (appVersion) Object.defineProperty(globalThis, "__APP_VERSION__", appVersion);
  else Reflect.deleteProperty(globalThis, "__APP_VERSION__");
});

test("subscribes on HTTP origins where crypto.randomUUID is unavailable", async () => {
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { getRandomValues: originalCrypto.getRandomValues.bind(originalCrypto) },
  });

  await useSubscribeFleetReport()(" reader@example.com ");

  expect(sent).toHaveLength(1);
  expect(sent[0]).toEqual({
    submission_id: expect.stringMatching(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    ),
    user_id: "user-1",
    org_name: "Test swarm",
    swarm_version: "test",
    email: "reader@example.com",
    newsletter_consent: false,
    message: "[fleet_report] subscribed to the monthly fleet benchmark report",
    submitted_at: expect.any(String),
  });
});

test("still requires a selected user before subscribing", async () => {
  userId = null;
  await expect(useSubscribeFleetReport()("reader@example.com")).rejects.toThrow(
    "Pick a user first.",
  );
  expect(sent).toHaveLength(0);
});
