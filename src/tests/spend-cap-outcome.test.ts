import { describe, expect, test } from "bun:test";
import { classifyProviderErrorOf } from "../commands/provider-error-class";
import { classifyRateLimitOutcome, parseSpendCapMessage } from "../commands/rate-limit-outcome";
import { MAX_SPEND_CAP_HOLD_MS } from "../utils/error-tracker";

const NOW = Date.parse("2026-11-12T21:14:00Z");

/** The body from the report, as the task failure carried it. */
const REPORTED =
  '403 {"message":"Key limit exceeded (weekly limit)...","code":403,"metadata":{"limit_source":"openrouter_key_limit","scope":"key_limit","limit_usd":1,"spend_usd":1.07,"resets_at":"2026-11-16T00:00:00Z"}}';

/** The full OpenRouter body. Its remedy hint says "usage limit", which read as a 5-minute rate limit. */
const FULL =
  '403: {"message":"Key limit exceeded (weekly limit). Manage it using https://openrouter.ai/workspaces/default/keys/abc. $1.07 of $1.00 used; resets 2026-11-16T00:00:00.000Z.","code":403,"metadata":{"limit_source":"openrouter_key_limit","remedy_hint":"Raise or remove this API key\'s usage limit at https://openrouter.ai/settings/keys, or use a key without a limit.","scope":"key_limit","limit_usd":1,"spend_usd":1.066227867,"resets_at":"2026-11-16T00:00:00.000Z"}}';

describe("OpenRouter spend caps", () => {
  test("the reported 403 body is a spend cap held until resets_at", () => {
    expect(parseSpendCapMessage(REPORTED)).toEqual({
      limitUsd: 1,
      spendUsd: 1.07,
      resetsAt: "2026-11-16T00:00:00.000Z",
    });
    expect(classifyRateLimitOutcome({}, REPORTED, NOW)).toEqual({
      kind: "key",
      rateLimitedUntil: "2026-11-16T00:00:00.000Z",
      spendCap: { limitUsd: 1, spendUsd: 1.07, resetsAt: "2026-11-16T00:00:00.000Z" },
    });
  });

  test("the full body with its 'usage limit' remedy hint is a spend cap, not a 5-minute rate limit", () => {
    const outcome = classifyRateLimitOutcome({}, FULL, NOW);
    expect(outcome.kind === "key" && outcome.rateLimitedUntil).toBe("2026-11-16T00:00:00.000Z");
    expect(outcome.kind === "key" && outcome.spendCap?.spendUsd).toBe(1.066227867);
  });

  test("the message alone gives the amounts and the reset", () => {
    expect(
      parseSpendCapMessage("Key limit exceeded. $1.07 of $1.00 used; resets 2026-11-16T00:00:00Z."),
    ).toEqual({ limitUsd: 1, spendUsd: 1.07, resetsAt: "2026-11-16T00:00:00.000Z" });
  });

  test("a 402 with no reset holds the key for the full spend-cap horizon", () => {
    const text =
      '402 {"error":{"message":"Insufficient credits. Add more using https://openrouter.ai/settings/credits","code":402}}';
    const outcome = classifyRateLimitOutcome({}, text, NOW);
    expect(outcome).toEqual({
      kind: "key",
      rateLimitedUntil: new Date(NOW + MAX_SPEND_CAP_HOLD_MS).toISOString(),
      spendCap: { limitUsd: null, spendUsd: null, resetsAt: null },
    });
  });

  test("a spend cap is the credits fallback class; a plain rate limit stays rate_limit", () => {
    const pi = (text: string) =>
      classifyProviderErrorOf({ exitCode: 1 }, text, "deepseek/deepseek-v4", undefined, NOW);
    expect(pi(REPORTED)).toBe("credits");
    expect(pi("429 Too Many Requests")).toBe("rate_limit");
  });

  test("ordinary rate limits and Codex credits are not spend caps", () => {
    expect(parseSpendCapMessage("429 Too Many Requests")).toBeNull();
    expect(parseSpendCapMessage("Claude usage limit reached")).toBeNull();
    expect(parseSpendCapMessage("Your workspace is out of credits.")).toBeNull();
    expect(parseSpendCapMessage("Fable 5.1 requires usage credits")).toBeNull();
  });
});
