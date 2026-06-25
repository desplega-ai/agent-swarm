import { afterEach, describe, expect, test } from "bun:test";
import {
  __setAiSdkAgentRunnerForTest,
  type AiSdkAgentRunner,
  AiSdkAgentSession,
  checkAiSdkAgentCredentials,
  createAiSdkAgentTools,
} from "../providers/ai-sdk-agent-adapter";
import type { ProviderEvent, ProviderSessionConfig } from "../providers/types";

const TEST_AGENT_ID = "bbbb0000-0000-4000-8000-000000000031";

function config(overrides: Partial<ProviderSessionConfig> = {}): ProviderSessionConfig {
  return {
    prompt: "Say hi",
    systemPrompt: "You are a test agent.",
    model: "openai/gpt-5.4",
    role: "worker",
    agentId: TEST_AGENT_ID,
    taskId: "task-1",
    apiUrl: "http://localhost:3000",
    apiKey: "api-key",
    cwd: "/tmp",
    logFile: `/tmp/ai-sdk-agent-test-${Date.now()}-${Math.random().toString(36).slice(2)}.log`,
    env: { OPENAI_API_KEY: "sk-test" },
    ...overrides,
  };
}

afterEach(() => {
  __setAiSdkAgentRunnerForTest(null);
});

describe("checkAiSdkAgentCredentials", () => {
  test("requires OPENAI_API_KEY", () => {
    expect(checkAiSdkAgentCredentials({ OPENAI_API_KEY: "x" }).ready).toBe(true);
    const missing = checkAiSdkAgentCredentials({});
    expect(missing.ready).toBe(false);
    expect(missing.missing).toEqual(["OPENAI_API_KEY"]);
  });
});

describe("createAiSdkAgentTools", () => {
  test("wraps MCP tools and emits tool lifecycle events", async () => {
    const events: ProviderEvent[] = [];
    const tools = createAiSdkAgentTools({
      tools: [
        {
          name: "echo",
          description: "Echo",
          inputSchema: { type: "object", properties: { value: { type: "string" } } },
        },
      ],
      client: {
        callTool: async (_name, args) => ({
          content: [{ type: "text", text: `ok:${String(args.value)}` }],
        }),
      },
      emit: (event) => events.push(event),
    });

    const output = await tools.echo.execute?.({ value: "x" }, { toolCallId: "call-1" } as never);
    expect(output).toBe("ok:x");
    expect(events.map((event) => event.type)).toEqual(["tool_start", "tool_end"]);
    expect(events[0]).toMatchObject({ type: "tool_start", toolName: "echo" });
    expect(events[1]).toMatchObject({ type: "tool_end", toolName: "echo", result: "ok:x" });
  });
});

describe("AiSdkAgentSession", () => {
  test("emits session_init/result, returns output, and tags ai-sdk-agent cost", async () => {
    const events: ProviderEvent[] = [];
    const runner: AiSdkAgentRunner = async ({ tools, onTextDelta, onStepUsage }) => {
      const toolOutput = await tools.echo.execute?.({ value: "from-runner" }, {
        toolCallId: "runner-call",
      } as never);
      expect(toolOutput).toBe("mcp:from-runner");
      const skillOutput = await tools.Skill.execute?.({ name: "work-on-task" }, {
        toolCallId: "skill-call",
      } as never);
      expect(skillOutput).toContain("# Work on Task");
      onTextDelta("hello");
      onStepUsage({
        inputTokens: 1_000,
        inputTokenDetails: {
          noCacheTokens: 900,
          cacheReadTokens: 100,
          cacheWriteTokens: undefined,
        },
        outputTokens: 500,
        outputTokenDetails: { textTokens: 500, reasoningTokens: undefined },
        totalTokens: 1_500,
        raw: undefined,
      });
      return { output: "hello", usage: { inputTokens: 1_000, outputTokens: 500, steps: 1 } };
    };

    const session = new AiSdkAgentSession(config(), {
      runner,
      mcpClientFactory: () => ({
        initialize: async () => {},
        listTools: async () => [
          {
            name: "echo",
            description: "Echo",
            inputSchema: { type: "object", properties: { value: { type: "string" } } },
          },
        ],
        callTool: async (name, args) => {
          if (name === "skill-list") {
            expect(args).toEqual({ installedOnly: true, includeContent: true });
            return {
              content: [{ type: "text", text: "Found 1 skill(s)." }],
              structuredContent: {
                success: true,
                skills: [
                  {
                    id: "skill-1",
                    name: "work-on-task",
                    description: "Task lifecycle",
                    content: "# Work on Task\n\nLifecycle.",
                  },
                ],
                total: 1,
              },
            };
          }
          return {
            content: [{ type: "text", text: `mcp:${String(args.value)}` }],
          };
        },
      }),
    });
    session.onEvent((event) => events.push(event));

    const result = await session.waitForCompletion();
    expect(result.exitCode).toBe(0);
    expect(result.output).toBe("hello");
    expect(result.cost?.provider).toBe("ai-sdk-agent");
    expect(result.cost?.model).toBe("gpt-5.4");
    expect(events.some((event) => event.type === "session_init")).toBe(true);
    expect(events.some((event) => event.type === "tool_start")).toBe(true);
    expect(events.some((event) => event.type === "tool_end")).toBe(true);
    expect(
      events.some(
        (event) => event.type === "tool_end" && event.toolName === "Skill" && event.result,
      ),
    ).toBe(true);
    expect(events.some((event) => event.type === "context_usage")).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "result", isError: false });
  });

  test("returns an error result when aborted", async () => {
    const runner: AiSdkAgentRunner = async ({ abortSignal }) => {
      if (abortSignal.aborted) throw new Error("aborted by test");
      await new Promise<void>((_resolve, reject) => {
        abortSignal.addEventListener("abort", () => reject(new Error("aborted by test")), {
          once: true,
        });
      });
      return {};
    };

    const session = new AiSdkAgentSession(config(), {
      runner,
      mcpClientFactory: () => ({
        initialize: async () => {},
        listTools: async () => [],
        callTool: async () => ({ content: [] }),
      }),
    });
    setTimeout(() => void session.abort("test"), 0);
    const result = await session.waitForCompletion();
    expect(result.exitCode).toBe(1);
    expect(result.isError).toBe(true);
    expect(result.cost?.provider).toBe("ai-sdk-agent");
    expect(result.failureReason).toContain("aborted");
  });
});
