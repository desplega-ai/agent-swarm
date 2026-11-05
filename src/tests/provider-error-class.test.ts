import { describe, expect, test } from "bun:test";
import { classifyProviderError, classifyProviderErrorOf } from "../commands/provider-error-class";

const NOW = Date.parse("2026-11-05T10:00:00Z");

function classOf(
  failureReason: string | undefined,
  extra: Record<string, unknown> = {},
  model = "claude-opus-5-5",
) {
  return classifyProviderErrorOf({ exitCode: 1, ...extra }, failureReason, model, undefined, NOW);
}

describe("classifyProviderErrorOf: provider errors per harness", () => {
  const cases: [string, string | undefined, Record<string, unknown>, string, string][] = [
    // claude: structured rate_limit_event, then the error tracker's labels.
    [
      "claude key-wide rate limit event",
      "Rate limit hit",
      { rateLimitResetAt: "2026-11-05T12:00:00Z" },
      "claude-opus-5-5",
      "rate_limit",
    ],
    ["claude usage limit text", "Claude usage limit reached", {}, "claude-opus-5-5", "rate_limit"],
    [
      "claude weekly model window event",
      "Session error (exit code 1)",
      {
        modelRateLimit: {
          window: "seven_day_opus",
          model: "opus",
          resetAt: "2026-11-08T00:00:00Z",
        },
      },
      "claude-opus-5-5",
      "model_window",
    ],
    [
      "claude seat mismatch event",
      "Session error (exit code 1)",
      { creditsRequired: { observedAt: "2026-11-05T09:59:00Z" } },
      "claude-fable-5-1",
      "seat",
    ],
    [
      "claude 5xx",
      "Server error (API overloaded): Service unavailable",
      {},
      "claude-opus-5-5",
      "overloaded",
    ],
    ["claude 529", "API Error: 529 overloaded_error", {}, "claude-opus-5-5", "overloaded"],
    ["claude auth", "Authentication failed: invalid token", {}, "claude-opus-5-5", "auth"],
    // codex
    [
      "codex credits exhausted",
      "Your workspace is out of credits. Ask your workspace owner to refill in order to continue.",
      {},
      "gpt-6.1-sol",
      "credits",
    ],
    [
      "codex auth",
      "[auth-error] Codex authentication failed — check OPENAI_API_KEY or ChatGPT login.",
      {},
      "gpt-6.1-sol",
      "auth",
    ],
    ["codex 429", "429 Too Many Requests", {}, "gpt-6.1-sol", "rate_limit"],
    // pi / opencode / gateways
    [
      "opencode overloaded",
      "system text: opencode error: provider overloaded",
      {},
      "openrouter/deepseek/deepseek-v4.1-flash",
      "overloaded",
    ],
    [
      "gateway 503",
      "provider returned error: 503 service unavailable",
      {},
      "openrouter/deepseek/deepseek-v4.1-flash",
      "server_error",
    ],
    [
      "gateway 502",
      "upstream error: HTTP 502 Bad Gateway",
      {},
      "openrouter/deepseek/deepseek-v4.1-flash",
      "server_error",
    ],
    // Every provider 5xx, not just 500-504.
    [
      "gateway 521",
      "provider returned error: 521 web server is down",
      {},
      "openrouter/deepseek/deepseek-v4.1-flash",
      "server_error",
    ],
    [
      "gateway 507",
      "upstream error: HTTP 507 Insufficient Storage",
      {},
      "openrouter/deepseek/deepseek-v4.1-flash",
      "server_error",
    ],
    ["api 599", "API Error: status 599", {}, "claude-opus-5-5", "server_error"],
    [
      "auth error wrapper",
      "Authentication error: Authentication failed: invalid key",
      {},
      "openrouter/deepseek/deepseek-v4.1-flash",
      "auth",
    ],
  ];
  for (const [name, reason, extra, model, expected] of cases) {
    test(name, () => {
      expect(classOf(reason, extra, model)).toBe(expected as never);
    });
  }
});

describe("never a fallback", () => {
  const cases: [string, string | undefined, Record<string, unknown>][] = [
    ["task failure", "Error during execution", {}],
    ["generic exit", "Claude process exited with code 1", {}],
    ["tool error text", "Bash tool failed: command not found", {}],
    ["context overflow", "prompt is too long: 210000 tokens > 200000 maximum", {}],
    ["context overflow (codex)", "context_length_exceeded", {}],
    ["budget refusal", "Budget limit exceeded", {}],
    ["max turns", "Max turns exceeded", {}],
    ["cancellation", "Rate limit hit", { errorCategory: "cancelled" }],
    ["transient codex refresh lock", "[auth-error] waiting for the refresh lock", {}],
    ["no reason", undefined, {}],
    // A 5xx-looking number that is not a status.
    ["5xx-looking count", "Error: wrote 521 lines, then the test failed", {}],
    // Harness-side exceptions (MCP / transport): their text never decides.
    [
      "MCP transport 503",
      "MCP error -32000: HTTP 503 Service Unavailable",
      { errorOrigin: "harness" },
    ],
    [
      "MCP tool 429",
      "429 Too Many Requests from the GitHub MCP server",
      { errorOrigin: "harness" },
    ],
    ["MCP tool 401", "HTTP 401 Unauthorized", { errorOrigin: "harness" }],
  ];
  for (const [name, reason, extra] of cases) {
    test(name, () => {
      expect(classOf(reason, extra)).toBeNull();
    });
  }

  test("a clean exit is never a fallback, even with a rate-limit event", () => {
    expect(
      classifyProviderErrorOf(
        { exitCode: 0, rateLimitResetAt: "2026-11-05T12:00:00Z" },
        undefined,
        "claude-opus-5-5",
      ),
    ).toBeNull();
  });

  test("a context-overflow text wins over a rate-limit outcome", () => {
    expect(
      classifyProviderError({ exitCode: 1 }, "maximum context length exceeded", {
        kind: "key",
        rateLimitedUntil: "2026-11-05T12:00:00Z",
      }),
    ).toBeNull();
  });
});
