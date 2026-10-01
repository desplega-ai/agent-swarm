import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { z } from "zod";
import { SummaryWithRatingsSchema } from "../../be/memory/raters/llm.js";
import {
  completeStructured,
  completeStructuredWithModel,
  defaultSpawnClaudeCli,
} from "../../utils/internal-ai/complete-structured.js";
import type { ResolvedCredential } from "../../utils/internal-ai/credentials.js";
import { summaryToolSchema } from "../../utils/internal-ai/summarize-session.js";

const ResultZodSchema = z.object({
  summary: z.string(),
  count: z.number(),
});

const ResultToolSchema = Type.Object({
  summary: Type.String(),
  count: Type.Number(),
});

/** Build a minimal `AssistantMessage` for `_complete` injection. */
function makeMsg(content: any[]): any {
  return {
    role: "assistant",
    content,
    api: "responses",
    provider: "openai",
    model: "gpt-5.4-mini",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: Date.now(),
  };
}

describe("completeStructured", () => {
  test("happy path: tool-call matches schema → returns parsed object, no retries", async () => {
    let invocations = 0;
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      _credentialOverride: {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      _complete: async () => {
        invocations++;
        return makeMsg([
          {
            type: "toolCall",
            id: "call_1",
            name: "record_result",
            arguments: { summary: "ok", count: 7 },
          },
        ]);
      },
    });
    expect(invocations).toBe(1);
    expect(result).toEqual({ summary: "ok", count: 7 });
  });

  test("session summary with a blank referencesSource is accepted on the first call", async () => {
    let invocations = 0;
    const args = {
      summary: "learned things",
      ratings: [
        { id: "m1", score: 0.9, reasoning: "useful", referencesSource: "linear:DES-1" },
        { id: "m2", score: 0.1, reasoning: "not used", referencesSource: "" },
        { id: "m3", score: 0.5, reasoning: "neutral", referencesSource: "   " },
      ],
    };
    const result = await completeStructured({
      zodSchema: SummaryWithRatingsSchema,
      toolSchema: summaryToolSchema,
      toolName: "record_session_summary",
      toolDescription: "Record the session summary.",
      systemPrompt: "sys",
      userPrompt: "user",
      _credentialOverride: {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      _complete: async () => {
        invocations++;
        return makeMsg([
          { type: "toolCall", id: "call_1", name: "record_session_summary", arguments: args },
        ]);
      },
    });
    expect(invocations).toBe(1);
    expect(result?.ratings).toHaveLength(3);
  });

  for (const { label, text, expected } of [
    {
      label: "bare JSON",
      text: '{"summary":"bare","count":1}',
      expected: { summary: "bare", count: 1 },
    },
    {
      label: "json-fenced JSON",
      text: '```json\n{"summary":"json fenced","count":2}\n```',
      expected: { summary: "json fenced", count: 2 },
    },
    {
      label: "untagged-fenced JSON",
      text: '```\n{"summary":"untagged fenced","count":3}\n```',
      expected: { summary: "untagged fenced", count: 3 },
    },
  ]) {
    test(`assistant text fallback: ${label} returns without retrying`, async () => {
      let invocations = 0;
      const result = await completeStructured({
        zodSchema: ResultZodSchema,
        toolSchema: ResultToolSchema,
        toolName: "record_result",
        toolDescription: "Record the result.",
        systemPrompt: "sys",
        userPrompt: "user",
        _credentialOverride: {
          kind: "openrouter",
          apiKey: "test",
          modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
        },
        _complete: async () => {
          invocations++;
          return makeMsg([{ type: "text", text }]);
        },
      });

      expect(invocations).toBe(1);
      expect(result).toEqual(expected);
    });
  }

  test("unknown catalog model returns null without calling complete", async () => {
    let invocations = 0;
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      _credentialOverride: {
        kind: "openai-codex",
        apiKey: "test",
        modelDefault: "openai-codex/nonexistent-model",
      },
      _complete: async () => {
        invocations++;
        return makeMsg([]);
      },
    });
    expect(result).toBeNull();
    expect(invocations).toBe(0);
  });

  test("passes a provider-compatible forced tool choice", async () => {
    const credentials: ResolvedCredential[] = [
      {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      { kind: "openai", apiKey: "test", modelDefault: "openai/gpt-6-luna" },
      {
        kind: "openai-codex",
        apiKey: "test",
        modelDefault: "openai-codex/gpt-6-luna",
      },
      {
        kind: "anthropic",
        apiKey: "test",
        modelDefault: "anthropic/claude-haiku-4-5",
      },
    ];

    for (const credential of credentials) {
      let receivedToolChoice: unknown;
      await completeStructured({
        zodSchema: ResultZodSchema,
        toolSchema: ResultToolSchema,
        toolName: "record_result",
        toolDescription: "Record the result.",
        systemPrompt: "sys",
        userPrompt: "user",
        _credentialOverride: credential,
        _complete: async (_model, _context, options) => {
          receivedToolChoice = options?.toolChoice;
          return makeMsg([
            {
              type: "toolCall",
              id: "call_1",
              name: "record_result",
              arguments: { summary: "ok", count: 1 },
            },
          ]);
        },
      });

      expect(receivedToolChoice).toEqual(
        credential.kind === "anthropic" ? { type: "tool", name: "record_result" } : "required",
      );
    }
  });

  test("assistant text fallback retries when JSON does not match the schema", async () => {
    let invocations = 0;
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      _credentialOverride: {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      _complete: async () => {
        invocations++;
        return makeMsg([
          {
            type: "text",
            text:
              invocations === 1 ? '{"summary":"missing count"}' : '{"summary":"valid","count":2}',
          },
        ]);
      },
    });

    expect(invocations).toBe(2);
    expect(result).toEqual({ summary: "valid", count: 2 });
  });

  test("no tool call for 3 attempts → returns null, exactly retries invocations", async () => {
    let invocations = 0;
    const original = console.error;
    const errors: unknown[][] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await completeStructured({
        zodSchema: ResultZodSchema,
        toolSchema: ResultToolSchema,
        toolName: "record_result",
        toolDescription: "Record the result.",
        systemPrompt: "sys",
        userPrompt: "user",
        retries: 3,
        callerTag: "session-summary:test",
        _credentialOverride: {
          kind: "openrouter",
          apiKey: "test",
          modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
        },
        _complete: async () => {
          invocations++;
          return makeMsg([{ type: "text", text: "sure, here you go" }]);
        },
      });
      expect(invocations).toBe(3);
      expect(result).toBeNull();
      expect(errors).toEqual([
        [
          "internal-ai: structured output failed after 3 retries (callerTag=session-summary:test kind=openrouter): no tool call in response",
        ],
      ]);
    } finally {
      console.error = original;
    }
  });

  test("bad shape then good shape → returns parsed object with 2 invocations", async () => {
    let invocations = 0;
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      _credentialOverride: {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      _complete: async () => {
        invocations++;
        if (invocations === 1) {
          return makeMsg([
            {
              type: "toolCall",
              id: "call_1",
              name: "record_result",
              arguments: { summary: "ok" /* missing count */ },
            },
          ]);
        }
        return makeMsg([
          {
            type: "toolCall",
            id: "call_2",
            name: "record_result",
            arguments: { summary: "fixed", count: 42 },
          },
        ]);
      },
    });
    expect(invocations).toBe(2);
    expect(result).toEqual({ summary: "fixed", count: 42 });
  });

  test("claude-cli kind via injected _spawnClaudeCli", async () => {
    let spawnCalls = 0;
    let receivedPrompt = "";
    let receivedModel = "";
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "SYSTEM",
      userPrompt: "USER",
      _credentialOverride: { kind: "claude-cli", modelDefault: "haiku" } as ResolvedCredential,
      _spawnClaudeCli: async (prompt, model) => {
        spawnCalls++;
        receivedPrompt = prompt;
        receivedModel = model;
        return JSON.stringify({ summary: "cli result", count: 1 });
      },
    });
    expect(spawnCalls).toBe(1);
    expect(receivedPrompt).toStartWith("SYSTEM\n\nUSER");
    // userPrompt is augmented with the JSON schema for the claude-cli path.
    expect(receivedPrompt).toContain('matching this schema:\n{"');
    expect(receivedModel).toBe("haiku");
    expect(result).toEqual({ summary: "cli result", count: 1 });
  });

  test("claude-cli kind: receives a JSON schema derived from zodSchema", async () => {
    let receivedSchema: object | undefined;
    await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      _credentialOverride: { kind: "claude-cli", modelDefault: "haiku" } as ResolvedCredential,
      _spawnClaudeCli: async (_prompt, _model, _signal, jsonSchema) => {
        receivedSchema = jsonSchema;
        return JSON.stringify({ summary: "ok", count: 1 });
      },
    });
    expect(receivedSchema).toBeDefined();
    const schema = receivedSchema as {
      $schema: string;
      type: string;
      properties: { summary: { type: string }; count: { type: string } };
      required: string[];
    };
    expect(schema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    expect(schema.type).toBe("object");
    expect(schema.properties.summary.type).toBe("string");
    expect(schema.properties.count.type).toBe("number");
    expect(schema.required).toEqual(expect.arrayContaining(["summary", "count"]));
  });

  test("claude-cli kind: retries when JSON parse fails", async () => {
    let spawnCalls = 0;
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      retries: 3,
      _credentialOverride: { kind: "claude-cli", modelDefault: "haiku" },
      _spawnClaudeCli: async () => {
        spawnCalls++;
        if (spawnCalls < 3) return "not json";
        return JSON.stringify({ summary: "third time", count: 99 });
      },
    });
    expect(spawnCalls).toBe(3);
    expect(result).toEqual({ summary: "third time", count: 99 });
  });

  test("claude-cli exhaustion logs one scrubbed line", async () => {
    const original = console.error;
    const errors: unknown[][] = [];
    const secret = "example-sk-proj-abcdefghijklmnopqrstuvwxyz012345";
    console.error = (...args: unknown[]) => {
      errors.push(args);
    };
    try {
      const result = await completeStructured({
        zodSchema: ResultZodSchema,
        toolSchema: ResultToolSchema,
        toolName: "record_result",
        toolDescription: "Record the result.",
        systemPrompt: "sys",
        userPrompt: "user",
        retries: 1,
        callerTag: "session-summary:test",
        _credentialOverride: { kind: "claude-cli", modelDefault: "haiku" },
        _spawnClaudeCli: async () => {
          throw new Error(`provider failed with ${secret}`);
        },
      });

      expect(result).toBeNull();
      expect(errors).toHaveLength(1);
      expect(errors[0]).toHaveLength(1);
      expect(errors[0]?.[0]).toBeString();
      expect(errors[0]?.[0]).toContain("callerTag=session-summary:test kind=claude-cli");
      expect(errors[0]?.[0]).toContain("provider failed with example-[REDACTED:");
      expect(errors[0]?.[0]).not.toContain(secret);
    } finally {
      console.error = original;
    }
  });

  test("cred === null short-circuits and returns null without calling complete", async () => {
    let invocations = 0;
    const result = await completeStructured({
      zodSchema: ResultZodSchema,
      toolSchema: ResultToolSchema,
      toolName: "record_result",
      toolDescription: "Record the result.",
      systemPrompt: "sys",
      userPrompt: "user",
      _resolveCredential: async () => null,
      _complete: async () => {
        invocations++;
        return makeMsg([]);
      },
    });
    expect(invocations).toBe(0);
    expect(result).toBeNull();
  });

  test("emits internal-ai: kind=... callerTag=... log on successful credential resolution", async () => {
    const origLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    };
    try {
      await completeStructured({
        zodSchema: ResultZodSchema,
        toolSchema: ResultToolSchema,
        toolName: "record_result",
        toolDescription: "Record the result.",
        systemPrompt: "sys",
        userPrompt: "user",
        callerTag: "session-summary:test",
        _credentialOverride: {
          kind: "openrouter",
          apiKey: "test",
          modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
        },
        _complete: async () =>
          makeMsg([
            {
              type: "toolCall",
              id: "1",
              name: "record_result",
              arguments: { summary: "ok", count: 1 },
            },
          ]),
      });
    } finally {
      console.log = origLog;
    }
    const match = lines.find(
      (l) =>
        l.includes("internal-ai: kind=openrouter") && l.includes("callerTag=session-summary:test"),
    );
    expect(match).toBeDefined();
  });
});

describe("defaultSpawnClaudeCli", () => {
  test("sets SKIP_SESSION_SUMMARY=1 in the child env (Stop-hook recursion guard)", async () => {
    // Without this guard, the spawned `claude -p` summarizer session fires the
    // same global Stop hook on exit, which spawns another summarizer claude,
    // recursively — observed OOM-wedging 8GB E2B worker sandboxes.
    const fakeBinary = `/tmp/fake-claude-${Date.now()}-${Math.random().toString(36).slice(2)}.sh`;
    await Bun.write(
      fakeBinary,
      '#!/usr/bin/env bash\ncat >/dev/null\nprintf \'{"result":"SKIP_SESSION_SUMMARY=%s"}\' "$SKIP_SESSION_SUMMARY"\n',
    );
    const savedBinary = process.env.CLAUDE_BINARY;
    const savedSkip = process.env.SKIP_SESSION_SUMMARY;
    const savedBridge = process.env.SWARM_USE_CLAUDE_BRIDGE;
    process.env.CLAUDE_BINARY = `bash ${fakeBinary}`;
    // Ensure a false-pass via inheritance is impossible.
    delete process.env.SKIP_SESSION_SUMMARY;
    delete process.env.SWARM_USE_CLAUDE_BRIDGE;
    try {
      const out = await defaultSpawnClaudeCli("prompt", "haiku");
      expect(out).toBe("SKIP_SESSION_SUMMARY=1");
    } finally {
      if (savedBinary === undefined) delete process.env.CLAUDE_BINARY;
      else process.env.CLAUDE_BINARY = savedBinary;
      if (savedSkip !== undefined) process.env.SKIP_SESSION_SUMMARY = savedSkip;
      if (savedBridge !== undefined) process.env.SWARM_USE_CLAUDE_BRIDGE = savedBridge;
      await Bun.$`rm -f ${fakeBinary}`.quiet();
    }
  });
});

describe("completeStructuredWithModel", () => {
  const baseOpts = {
    zodSchema: ResultZodSchema,
    toolSchema: ResultToolSchema,
    toolName: "record_result",
    toolDescription: "Record the result.",
    systemPrompt: "sys",
    userPrompt: "user",
  };

  test("pi-ai path: reports the credential's resolved model next to the data", async () => {
    const result = await completeStructuredWithModel({
      ...baseOpts,
      _credentialOverride: {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      _complete: async () =>
        makeMsg([
          {
            type: "toolCall",
            id: "call_1",
            name: "record_result",
            arguments: { summary: "ok", count: 7 },
          },
        ]),
    });
    expect(result).toEqual({
      data: { summary: "ok", count: 7 },
      model: "openrouter/deepseek/deepseek-v4.1-flash",
    });
  });

  test("assistant-text fallback also reports the model", async () => {
    const result = await completeStructuredWithModel({
      ...baseOpts,
      _credentialOverride: {
        kind: "openrouter",
        apiKey: "test",
        modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
      },
      _complete: async () => makeMsg([{ type: "text", text: '{"summary":"t","count":2}' }]),
    });
    expect(result?.model).toBe("openrouter/deepseek/deepseek-v4.1-flash");
    expect(result?.data).toEqual({ summary: "t", count: 2 });
  });

  test("claude-cli path: reports the cli model alias", async () => {
    const result = await completeStructuredWithModel({
      ...baseOpts,
      _credentialOverride: { kind: "claude-cli", modelDefault: "haiku" } as ResolvedCredential,
      _spawnClaudeCli: async () => JSON.stringify({ summary: "cli", count: 1 }),
    });
    expect(result).toEqual({ data: { summary: "cli", count: 1 }, model: "haiku" });
  });
});
