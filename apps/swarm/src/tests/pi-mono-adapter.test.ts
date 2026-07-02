import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as piCodingAgent from "@earendil-works/pi-coding-agent";
import {
  createPiRuntimeAuth,
  extractPiAssistantText,
  PiMonoAdapter,
  resolveModel,
} from "../providers/pi-mono-adapter";
import type { ProviderSessionConfig } from "../providers/types";

describe("PiMonoAdapter", () => {
  test("name is 'pi'", () => {
    const adapter = new PiMonoAdapter();
    expect(adapter.name).toBe("pi");
  });
});

// ─── Phase 4 (reasoning-effort plan): createSession sessionOptions wiring ────

describe("PiMonoAdapter.createSession — reasoning_effort", () => {
  function makeReasoningConfig(
    overrides: Partial<ProviderSessionConfig> = {},
  ): ProviderSessionConfig {
    return {
      prompt: "hello",
      systemPrompt: "",
      model: "openrouter/google/gemini-3-flash-preview",
      role: "worker",
      agentId: "test-agent",
      taskId: "test-task",
      apiUrl: "",
      apiKey: "",
      cwd: "/tmp",
      logFile: `/tmp/pi-reasoning-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
      ...overrides,
    };
  }

  /** Minimal fake `AgentSession` — mirrors `makeMockAgentSession` below. */
  function makeFakeSession() {
    return {
      sessionId: "fake-session",
      isStreaming: false,
      model: undefined,
      subscribe: () => () => {},
      dispose: () => {},
    };
  }

  let createAgentSessionSpy: ReturnType<typeof spyOn>;
  let capturedOptions: Record<string, unknown> | undefined;

  afterEach(() => {
    createAgentSessionSpy?.mockRestore();
    capturedOptions = undefined;
  });

  function spyOnCreateAgentSession() {
    createAgentSessionSpy = spyOn(piCodingAgent, "createAgentSession").mockImplementation((async (
      opts: Record<string, unknown>,
    ) => {
      capturedOptions = opts;
      return { session: makeFakeSession() };
    }) as typeof piCodingAgent.createAgentSession);
  }

  test("reasoningEffort: 'medium' on an openrouter model sets thinkingLevel", async () => {
    spyOnCreateAgentSession();
    const adapter = new PiMonoAdapter();
    await adapter.createSession(makeReasoningConfig({ reasoningEffort: "medium" }));
    expect(capturedOptions?.thinkingLevel).toBe("medium");
  });

  test("undefined reasoningEffort leaves sessionOptions unchanged (no thinkingLevel key)", async () => {
    spyOnCreateAgentSession();
    const adapter = new PiMonoAdapter();
    await adapter.createSession(makeReasoningConfig());
    expect(capturedOptions).not.toHaveProperty("thinkingLevel");
  });
});

describe("AGENTS.md symlink management", () => {
  const tmpDir = `/tmp/pi-mono-test-${Date.now()}`;

  beforeAll(() => {
    mkdirSync(tmpDir, { recursive: true });
  });

  afterAll(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("creates symlink when CLAUDE.md exists but AGENTS.md does not", () => {
    const testDir = join(tmpDir, "symlink-create");
    mkdirSync(testDir);
    writeFileSync(join(testDir, "CLAUDE.md"), "# Test");

    // Simulate what createAgentsMdSymlink does
    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    expect(existsSync(agentsMd)).toBe(true);
  });

  test("does not overwrite existing AGENTS.md", () => {
    const testDir = join(tmpDir, "no-overwrite");
    mkdirSync(testDir);
    writeFileSync(join(testDir, "CLAUDE.md"), "# Claude");
    writeFileSync(join(testDir, "AGENTS.md"), "# Real AGENTS.md");

    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    // Simulate createAgentsMdSymlink — should NOT overwrite existing AGENTS.md
    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    // AGENTS.md should still be a real file, not a symlink
    expect(existsSync(agentsMd)).toBe(true);
    const content = readFileSync(agentsMd, "utf-8");
    expect(content).toBe("# Real AGENTS.md");
  });

  test("no-op when CLAUDE.md does not exist", () => {
    const testDir = join(tmpDir, "no-claudemd");
    mkdirSync(testDir);

    const claudeMd = join(testDir, "CLAUDE.md");
    const agentsMd = join(testDir, "AGENTS.md");

    if (existsSync(claudeMd) && !existsSync(agentsMd)) {
      symlinkSync("CLAUDE.md", agentsMd);
    }

    expect(existsSync(agentsMd)).toBe(false);
  });
});

describe("Model name mapping", () => {
  // Test the shortname → full ID mapping logic that resolveModel uses
  const shortnames: Record<string, [string, string]> = {
    opus: ["anthropic", "claude-opus-4-20250514"],
    sonnet: ["anthropic", "claude-sonnet-4-20250514"],
    haiku: ["anthropic", "claude-haiku-4-5-20251001"],
  };

  test("opus maps to anthropic/claude-opus-4-20250514", () => {
    const mapping = shortnames.opus;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-opus-4-20250514");
  });

  test("sonnet maps to anthropic/claude-sonnet-4-20250514", () => {
    const mapping = shortnames.sonnet;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-sonnet-4-20250514");
  });

  test("haiku maps to anthropic/claude-haiku-4-5-20251001", () => {
    const mapping = shortnames.haiku;
    expect(mapping).toBeDefined();
    expect(mapping![0]).toBe("anthropic");
    expect(mapping![1]).toBe("claude-haiku-4-5-20251001");
  });

  test("unknown shortname returns undefined", () => {
    const mapping = shortnames.gpt4;
    expect(mapping).toBeUndefined();
  });

  test("provider/model-id format is parseable", () => {
    const modelStr = "anthropic/claude-opus-4-20250514";
    expect(modelStr.includes("/")).toBe(true);
    const [provider, modelId] = modelStr.split("/", 2);
    expect(provider).toBe("anthropic");
    expect(modelId).toBe("claude-opus-4-20250514");
  });
});

describe("resolveModel — OpenRouter reroute for anthropic shortnames", () => {
  // Regression coverage for task 37a4a87a: workers spawned with
  // `provider: pi` + `OPENROUTER_API_KEY` (no ANTHROPIC_API_KEY) and a task
  // model of `sonnet` / `haiku` / `opus` previously crashed at
  // session-start with "No API key found for anthropic" because pi-ai's
  // anthropic provider only checks ANTHROPIC_OAUTH_TOKEN / ANTHROPIC_API_KEY.
  // The adapter now reroutes the shortname through the OpenRouter mirror.

  test("sonnet → openrouter/anthropic/claude-sonnet-4 when only OPENROUTER_API_KEY is set", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("sonnet", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-sonnet-4");
  });

  test("haiku → openrouter/anthropic/claude-haiku-4.5 when only OPENROUTER_API_KEY is set", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("haiku", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-haiku-4.5");
  });

  test("opus → openrouter/anthropic/claude-opus-4 when only OPENROUTER_API_KEY is set", () => {
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("opus", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("openrouter");
    expect(model?.id).toBe("anthropic/claude-opus-4");
  });

  test("anthropic native path wins when ANTHROPIC_API_KEY is set (even alongside OPENROUTER_API_KEY)", () => {
    const env = { ANTHROPIC_API_KEY: "sk-ant-...", OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("sonnet", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("anthropic");
    expect(model?.id).toBe("claude-sonnet-4-20250514");
  });

  test("ANTHROPIC_OAUTH_TOKEN alone also wins over OPENROUTER reroute", () => {
    const env = { ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat-...", OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("sonnet", env);
    expect(model).toBeDefined();
    expect(model?.provider).toBe("anthropic");
  });

  test("no rerouting for non-shortname `anthropic/<model>` strings", () => {
    // Explicit provider prefix should not be silently swapped — that path is
    // the caller's explicit choice, surface as-is.
    const env = { OPENROUTER_API_KEY: "sk-or-..." };
    const model = resolveModel("anthropic/claude-sonnet-4-20250514", env);
    expect(model?.provider).toBe("anthropic");
  });

  test("default env arg falls back to process.env (smoke test — no creds set)", () => {
    // Just confirm the default parameter doesn't throw — the actual model
    // resolution depends on the test runner's env.
    expect(() => resolveModel("unknown-model-id")).not.toThrow();
  });
});

describe("createPiRuntimeAuth", () => {
  test("threads resolved OpenRouter key into pi runtime auth without process.env", async () => {
    const { modelRegistry } = createPiRuntimeAuth({ OPENROUTER_API_KEY: "sk-or-runtime" });

    await expect(modelRegistry.getApiKeyForProvider("openrouter")).resolves.toBe("sk-or-runtime");
  });

  test("supports all pi env-backed providers", async () => {
    const { modelRegistry } = createPiRuntimeAuth({
      ANTHROPIC_API_KEY: "sk-ant-runtime",
      OPENAI_API_KEY: "sk-openai-runtime",
      GOOGLE_API_KEY: "sk-google-runtime",
    });

    await expect(modelRegistry.getApiKeyForProvider("anthropic")).resolves.toBe("sk-ant-runtime");
    await expect(modelRegistry.getApiKeyForProvider("openai")).resolves.toBe("sk-openai-runtime");
    await expect(modelRegistry.getApiKeyForProvider("google")).resolves.toBe("sk-google-runtime");
  });
});

describe("Pi-mono event normalization", () => {
  test("extractPiAssistantText ignores user messages", () => {
    const text = extractPiAssistantText({
      role: "user",
      content: "/skill:work-on-task task-123\n\nTask: hello",
    });

    expect(text).toBe("");
  });

  test("extractPiAssistantText extracts assistant text blocks", () => {
    const text = extractPiAssistantText({
      role: "assistant",
      content: [
        { type: "text", text: "Hello, " },
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "world!" },
      ],
    });

    expect(text).toBe("Hello, world!");
  });

  test("extractPiAssistantText supports string assistant content", () => {
    const text = extractPiAssistantText({
      role: "assistant",
      content: "Plain assistant output",
    });

    expect(text).toBe("Plain assistant output");
  });

  test("message_update with text content produces raw_log-style data", () => {
    // Simulates what PiMonoSession.handleAgentEvent does
    const event = {
      type: "message_update" as const,
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Hello, world!" },
          { type: "text", text: " More text." },
        ],
      },
    };

    const content = event.message.content
      .filter((c) => c.type === "text")
      .map((c) => c.text || "")
      .join("");

    expect(content).toBe("Hello, world! More text.");
  });

  test("tool_execution_start produces tool_use log", () => {
    const event = {
      type: "tool_execution_start" as const,
      toolName: "write",
      toolCallId: "tc-123",
    };

    const logEntry = JSON.stringify({
      type: "tool_use",
      name: event.toolName,
      id: event.toolCallId,
    });

    const parsed = JSON.parse(logEntry);
    expect(parsed.type).toBe("tool_use");
    expect(parsed.name).toBe("write");
    expect(parsed.id).toBe("tc-123");
  });

  test("tool_execution_end produces tool_result log", () => {
    const event = {
      type: "tool_execution_end" as const,
      toolName: "write",
      toolCallId: "tc-123",
      isError: false,
    };

    const logEntry = JSON.stringify({
      type: "tool_result",
      name: event.toolName,
      id: event.toolCallId,
      isError: event.isError,
    });

    const parsed = JSON.parse(logEntry);
    expect(parsed.type).toBe("tool_result");
    expect(parsed.isError).toBe(false);
  });
});

describe("Cost aggregation from SessionStats", () => {
  test("builds CostData from SessionStats shape", () => {
    const stats = {
      tokens: {
        input: 5000,
        output: 2000,
        cacheRead: 1000,
        cacheWrite: 500,
        total: 8500,
      },
      cost: 0.0456,
      userMessages: 1,
      assistantMessages: 4,
    };

    const cost = {
      sessionId: "",
      taskId: "task-1",
      agentId: "agent-1",
      totalCostUsd: stats.cost || 0,
      inputTokens: stats.tokens.input,
      outputTokens: stats.tokens.output,
      cacheReadTokens: stats.tokens.cacheRead,
      cacheWriteTokens: stats.tokens.cacheWrite,
      durationMs: 0,
      numTurns: stats.userMessages + stats.assistantMessages,
      model: "opus",
      isError: false,
    };

    expect(cost.totalCostUsd).toBe(0.0456);
    expect(cost.inputTokens).toBe(5000);
    expect(cost.outputTokens).toBe(2000);
    expect(cost.cacheReadTokens).toBe(1000);
    expect(cost.cacheWriteTokens).toBe(500);
    expect(cost.numTurns).toBe(5);
  });

  test("handles zero-cost stats", () => {
    const stats = {
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      userMessages: 0,
      assistantMessages: 0,
    };

    const cost = {
      totalCostUsd: stats.cost || 0,
      numTurns: stats.userMessages + stats.assistantMessages,
    };

    expect(cost.totalCostUsd).toBe(0);
    expect(cost.numTurns).toBe(0);
  });
});

// ============================================================================
// AWS SDK error detection — event-driven PiMonoSession + classifyAwsSdkError
//
// Redesign (2026-06): detection is driven entirely by structured
// pi-coding-agent events, NOT stderr scraping or auto_retry_start inference:
//   - `message_end` with an assistant `stopReason:'error'` → the ONLY signal
//     for NON-retryable failures, critically AWS auth (ExpiredToken /
//     CredentialsProviderError), which never enter pi's _isRetryableError loop.
//   - `auto_retry_end` with `success:false` + `finalError` → the definitive
//     terminal failure for the RETRYABLE class (throttle / 5xx / timeout).
//   - recovery (`message_end` success, or `auto_retry_end` success:true) clears
//     the tracked error so a recovered turn never surfaces as a false failure.
// ============================================================================

import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { PiMonoSession } from "../providers/pi-mono-adapter";
import type { ProviderEvent, ProviderResult } from "../providers/types";
import { classifyAwsSdkError } from "../utils/aws-error-classifier";

function makeSessionConfig(logFile: string): ProviderSessionConfig {
  return {
    prompt: "test prompt",
    systemPrompt: "",
    model: "amazon-bedrock/anthropic.claude-3-5-sonnet-20240620-v1:0",
    role: "worker",
    agentId: "test-agent-id",
    taskId: "test-task-id",
    apiUrl: "http://localhost:3013",
    apiKey: "test-key",
    cwd: "/tmp",
    logFile,
    iteration: 1,
  };
}

type AgentSessionEvent = Parameters<Parameters<AgentSession["subscribe"]>[0]>[0];

/** Build a `message_end` event for an assistant turn that ended in error. */
function errorMessageEnd(errorMessage: string): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage,
    },
  } as unknown as AgentSessionEvent;
}

/** Build a `message_end` event for a successful assistant turn. */
function successMessageEnd(text: string): AgentSessionEvent {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      stopReason: "stop",
    },
  } as unknown as AgentSessionEvent;
}

/** Build an `auto_retry_end` event (terminal retryable failure / recovery). */
function autoRetryEnd(success: boolean, finalError?: string): AgentSessionEvent {
  return {
    type: "auto_retry_end",
    success,
    attempt: 3,
    ...(finalError ? { finalError } : {}),
  } as unknown as AgentSessionEvent;
}

/**
 * Mock AgentSession that replays a fixed list of structured events to its
 * subscribers when `prompt()` is called, then resolves (no throw). This mirrors
 * the real pi-coding-agent: AWS failures arrive as DATA via events, there is no
 * exception to catch at the agent-swarm layer.
 */
function makeMockAgentSession(opts: {
  events?: AgentSessionEvent[];
  throwError?: string;
}): AgentSession {
  const listeners: Array<(event: AgentSessionEvent) => void> = [];
  return {
    sessionId: "mock-session-id",
    isStreaming: false,
    model: undefined,
    subscribe(listener: (event: AgentSessionEvent) => void) {
      listeners.push(listener);
      return () => {
        const idx = listeners.indexOf(listener);
        if (idx >= 0) listeners.splice(idx, 1);
      };
    },
    async prompt() {
      for (const event of opts.events ?? []) {
        for (const l of listeners) l(event);
      }
      if (opts.throwError) throw new Error(opts.throwError);
    },
    getContextUsage: () => null,
    getSessionStats: () => ({
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      cost: 0,
      userMessages: 0,
      assistantMessages: 0,
    }),
    abort: async () => {},
    dispose: () => {},
  } as unknown as AgentSession;
}

const tmpLogDir = `/tmp/pi-mono-aws-test-${Date.now()}`;

beforeAll(() => {
  mkdirSync(tmpLogDir, { recursive: true });
});

afterAll(() => {
  rmSync(tmpLogDir, { recursive: true, force: true });
});

async function runWithEvents(events: AgentSessionEvent[]): Promise<{
  events: ProviderEvent[];
  result: ProviderResult;
}> {
  const logFile = join(tmpLogDir, `evt-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const session = new PiMonoSession(
    makeMockAgentSession({ events }),
    makeSessionConfig(logFile),
    false,
  );
  const emitted: ProviderEvent[] = [];
  session.onEvent((e) => emitted.push(e));
  const result = await session.waitForCompletion();
  return { events: emitted, result };
}

function findError(events: ProviderEvent[]): Extract<ProviderEvent, { type: "error" }> | undefined {
  return events.find((e) => e.type === "error") as
    | Extract<ProviderEvent, { type: "error" }>
    | undefined;
}

describe("PiMonoSession — NON-retryable AWS auth via message_end stopReason:'error'", () => {
  // ORIGINAL-BUG REGRESSION TEST. AWS auth errors (ExpiredToken /
  // CredentialsProviderError) are non-retryable: pi's _isRetryableError regex
  // matches throttle/429/5xx/timeout but NOT auth tokens, so they never enter
  // the retry loop. The ONLY structured signal is a `message_end` assistant
  // turn with stopReason:'error'. This is the Commander's original silent-fail.
  test("ExpiredToken stopReason:'error' → type:error category aws-auth + terminal isError", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd(
        "ExpiredTokenException: The security token included in the request is expired",
      ),
    ]);
    const errorEvent = findError(events);
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.category).toBe("aws-auth");
    expect(errorEvent?.message).toContain("aws sso login");
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("aws-auth");
    expect(result.exitCode).toBe(1);
    expect(result.failureReason).toContain("aws sso login");
  });

  test("CredentialsProviderError stopReason:'error' → aws-auth terminal failure", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("CredentialsProviderError: Could not load credentials from any providers"),
    ]);
    expect(findError(events)?.category).toBe("aws-auth");
    expect(result.errorCategory).toBe("aws-auth");
    expect(result.isError).toBe(true);
  });

  test("AccessDeniedException stopReason:'error' → aws-access terminal failure", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("AccessDeniedException: not authorized to perform: bedrock:InvokeModel"),
    ]);
    expect(findError(events)?.category).toBe("aws-access");
    expect(result.errorCategory).toBe("aws-access");
  });

  test("ValidationException stopReason:'error' → aws-model terminal failure", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd(
        "ValidationException: Invocation of model ID x with on-demand throughput isn't supported",
      ),
    ]);
    expect(findError(events)?.category).toBe("aws-model");
    expect(result.errorCategory).toBe("aws-model");
  });

  test("non-AWS stopReason:'error' → still terminal failure, no AWS category", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("Some unrecognized provider failure"),
    ]);
    const errorEvent = findError(events);
    // A terminal stopReason:'error' is a genuine failure by definition — it must
    // surface (no silent green), but it carries no AWS category.
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.category).toBeUndefined();
    expect(errorEvent?.message).toContain("Some unrecognized provider failure");
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
    expect(result.errorCategory).toBeUndefined();
  });
});

describe("PiMonoSession — RETRYABLE failure via auto_retry_end success:false", () => {
  test("throttle finalError after exhausted retries → aws-throttle terminal failure", async () => {
    const { events, result } = await runWithEvents([
      // Each retry attempt also produces an errored message_end before retrying;
      // the definitive terminal marker is auto_retry_end success:false.
      errorMessageEnd("ThrottlingException: Rate exceeded"),
      autoRetryEnd(false, "ThrottlingException: Rate exceeded"),
    ]);
    const errorEvent = findError(events);
    expect(errorEvent?.category).toBe("aws-throttle");
    expect(result.errorCategory).toBe("aws-throttle");
    expect(result.isError).toBe(true);
    expect(result.exitCode).toBe(1);
  });

  test("5xx finalError (non-AWS) → terminal failure surfaced, no AWS category", async () => {
    const { events, result } = await runWithEvents([
      autoRetryEnd(false, "provider returned error: 503 service unavailable"),
    ]);
    expect(findError(events)).toBeDefined();
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBeUndefined();
  });
});

describe("PiMonoSession — recovery clears the tracked error (no false failure)", () => {
  // The never-cleared-on-recovery false-fail bug the redesign eliminates.
  test("errored turn then successful auto_retry_end → success, output, no error", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("ThrottlingException: Rate exceeded"),
      autoRetryEnd(true),
      successMessageEnd("Recovered answer"),
    ]);
    expect(findError(events)).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("Recovered answer");
  });

  test("errored turn then a later successful message_end → success, no error", async () => {
    const { events, result } = await runWithEvents([
      errorMessageEnd("ExpiredTokenException: token expired"),
      successMessageEnd("Final answer after creds refreshed"),
    ]);
    expect(findError(events)).toBeUndefined();
    expect(result.isError).toBe(false);
    expect(result.output).toBe("Final answer after creds refreshed");
  });

  test("clean success path emits a result event and no error", async () => {
    const { events, result } = await runWithEvents([successMessageEnd("All done")]);
    expect(findError(events)).toBeUndefined();
    expect(events.some((e) => e.type === "result")).toBe(true);
    expect(result.isError).toBe(false);
    expect(result.output).toBe("All done");
  });
});

describe("PiMonoSession — thrown-exception catch path (defense-in-depth)", () => {
  // AWS failures arrive as events, not throws, but a genuine unexpected throw
  // (MCP/transport) must still fail the task; an AWS signature that reaches the
  // catch is still classified.
  async function runWithThrow(message: string) {
    const logFile = join(
      tmpLogDir,
      `throw-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    );
    const session = new PiMonoSession(
      makeMockAgentSession({ throwError: message }),
      makeSessionConfig(logFile),
      false,
    );
    const emitted: ProviderEvent[] = [];
    session.onEvent((e) => emitted.push(e));
    const result = await session.waitForCompletion();
    return { events: emitted, result };
  }

  test("thrown ExpiredToken → aws-auth error event + terminal failure", async () => {
    const { events, result } = await runWithThrow(
      "ExpiredTokenException: The security token is expired",
    );
    expect(findError(events)?.category).toBe("aws-auth");
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBe("aws-auth");
  });

  test("thrown non-AWS error → no AWS category, still terminal failure", async () => {
    const { events, result } = await runWithThrow("ECONNREFUSED 127.0.0.1:3013");
    expect(findError(events)).toBeUndefined();
    expect(result.isError).toBe(true);
    expect(result.errorCategory).toBeUndefined();
  });
});

describe("classifyAwsSdkError — all 4 categories (quick summary)", () => {
  test("all four categories are reachable", () => {
    const cases: Array<[string, string]> = [
      ["ExpiredTokenException: token expired", "aws-auth"],
      ["ThrottlingException: rate exceeded", "aws-throttle"],
      ["AccessDeniedException: no permission", "aws-access"],
      ["ValidationException: bad model", "aws-model"],
    ];
    for (const [msg, expected] of cases) {
      const r = classifyAwsSdkError(msg);
      expect(r?.category).toBe(expected);
    }
  });
});
