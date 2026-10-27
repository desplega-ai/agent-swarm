import { describe, expect, mock, test } from "bun:test";
import type { OnboardingProviderSignal } from "../../../../api/types";

// Root tests do not resolve the `@/` alias; model.ts only needs the labels.
mock.module("@/lib/agent-runtime-models", () => ({ HARNESS_LABEL: {} }));
const { cardRollup, firstCredentialSwitch, rejectionText } = await import("./model");

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

describe("firstCredentialSwitch", () => {
  const unverified = {
    claude: { verified: false },
    codex: { verified: false },
    open: { verified: false },
    devin: { verified: false },
  };
  const onClaude = [
    { id: "lead", harnessProvider: "claude" },
    { id: "worker", harnessProvider: "claude" },
  ] as const;

  test("the first credential moves every agent to the card's harness", () => {
    expect(firstCredentialSwitch("codex_device", { codex: true }, unverified, onClaude)).toEqual({
      card: "codex",
      target: "codex",
      agentIds: ["lead", "worker"],
    });
  });

  test("the open harnesses card moves agents to its default target", () => {
    expect(firstCredentialSwitch("openrouter", { open: true }, unverified, onClaude)).toMatchObject(
      {
        card: "open",
        target: "pi",
      },
    );
  });

  test("a fresh full swarm: an OpenRouter key first moves the lead and all 10 workers to Pi-Mono", () => {
    // `--preset full`: 1 lead and 10 workers, all on Claude, no credential anywhere.
    const fleet = [
      { id: "lead", harnessProvider: "claude" as const, isLead: true },
      ...Array.from({ length: 10 }, (_, i) => ({
        id: `worker-${i + 1}`,
        harnessProvider: "claude" as const,
        isLead: false,
      })),
    ];
    expect(firstCredentialSwitch("openrouter", {}, unverified, fleet)).toEqual({
      card: "open",
      target: "pi",
      agentIds: fleet.map((a) => a.id),
    });
  });

  test("a DeepSeek key moves agents to dsh, the one harness that runs it", () => {
    expect(firstCredentialSwitch("deepseek", {}, unverified, onClaude)?.target).toBe("dsh");
  });

  test("a saved key or a verified worker on another card keeps the manual list", () => {
    expect(
      firstCredentialSwitch("codex_device", { claude: true }, unverified, onClaude),
    ).toBeNull();
    const claudeVerified = { ...unverified, claude: { verified: true } };
    expect(firstCredentialSwitch("codex_device", {}, claudeVerified, onClaude)).toBeNull();
  });

  test("Claude as the first credential changes nothing: the agents already run it", () => {
    const saved = { claude: true };
    expect(firstCredentialSwitch("claude_setup_token", saved, unverified, onClaude)).toBeNull();
  });

  test("an agent on one of the card's harnesses keeps the manual list", () => {
    const agents = [...onClaude, { id: "coder", harnessProvider: "opencode" }];
    expect(firstCredentialSwitch("openrouter", {}, unverified, agents)).toBeNull();
  });

  test("no agents: nothing to switch", () => {
    expect(firstCredentialSwitch("codex_device", {}, unverified, [])).toBeNull();
  });
});
