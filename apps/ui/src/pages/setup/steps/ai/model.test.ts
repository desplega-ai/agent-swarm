import { describe, expect, mock, test } from "bun:test";
import type { OnboardingProviderSignal } from "../../../../api/types";

// Root tests do not resolve the `@/` alias; model.ts only needs the labels.
mock.module("@/lib/agent-runtime-models", () => ({ HARNESS_LABEL: {} }));
const { cardRollup, rejectionText } = await import("./model");

function signal(over: Partial<OnboardingProviderSignal>): OnboardingProviderSignal {
  return { provider: "claude", state: "configured", workers: 1, verifiedWorkers: 0, ...over };
}

describe("cardRollup", () => {
  test("carries the error and the warning of the card's harnesses", () => {
    expect(cardRollup("claude", [signal({ error: "HTTP 401: nope" })])).toMatchObject({
      verified: false,
      error: "HTTP 401: nope",
      warning: null,
    });
    const warned = signal({ state: "verified", verifiedWorkers: 1, warning: "1 of 2 keys failed" });
    expect(cardRollup("claude", [warned])).toMatchObject({
      verified: true,
      error: null,
      warning: "1 of 2 keys failed",
    });
  });

  test("a verified harness hides another harness's failure on the same card", () => {
    const rollup = cardRollup("open", [
      signal({ provider: "pi", error: "HTTP 401: nope" }),
      signal({ provider: "opencode", state: "verified", verifiedWorkers: 1 }),
    ]);
    expect(rollup).toMatchObject({ verified: true, error: null, workers: 2, verifiedWorkers: 1 });
  });

  test("ignores harnesses of other cards", () => {
    expect(cardRollup("codex", [signal({ error: "HTTP 401" })]).error).toBeNull();
  });
});

describe("rejectionText", () => {
  test("a bare provider status becomes one sentence", () => {
    expect(rejectionText('HTTP 401: {"type":"error"}')).toBe(
      "The provider rejected the key (HTTP 401).",
    );
  });

  test("a worker message that explains itself stays as it is", () => {
    const message = "All 2 keys failed: key ending abcde (HTTP 401), key ending fghij (HTTP 401).";
    expect(rejectionText(message)).toBe(message);
  });
});
