import { describe, expect, test } from "bun:test";
import { Type } from "typebox";
import { z } from "zod";
import { completeStructured } from "../../utils/internal-ai/complete-structured.js";
import type { ResolvedCredential } from "../../utils/internal-ai/credentials.js";

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
        modelDefault: "openrouter/google/gemini-3-flash-preview",
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

  test("no tool call for 3 attempts → returns null, exactly retries invocations", async () => {
    let invocations = 0;
    const original = console.error;
    let errLines = 0;
    console.error = () => {
      errLines++;
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
        _credentialOverride: {
          kind: "openrouter",
          apiKey: "test",
          modelDefault: "openrouter/google/gemini-3-flash-preview",
        },
        _complete: async () => {
          invocations++;
          return makeMsg([{ type: "text", text: "sure, here you go" }]);
        },
      });
      expect(invocations).toBe(3);
      expect(result).toBeNull();
      expect(errLines).toBeGreaterThanOrEqual(1);
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
        modelDefault: "openrouter/google/gemini-3-flash-preview",
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
      type: string;
      properties: { summary: { type: string }; count: { type: string } };
      required: string[];
    };
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
          modelDefault: "openrouter/google/gemini-3-flash-preview",
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
