import { createOpenAI } from "@ai-sdk/openai";
import {
  dynamicTool,
  jsonSchema,
  type LanguageModelUsage,
  stepCountIs,
  ToolLoopAgent,
  type ToolSet,
} from "ai";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  computeAiSdkAgentCostUsd,
  getAiSdkAgentContextWindow,
  resolveAiSdkAgentModel,
} from "./ai-sdk-agent-models";
import { createAiSdkAgentSkillTool } from "./ai-sdk-agent-skill-tool";
import { readPkgVersion } from "./harness-version";
import { McpHttpClient } from "./pi-mono-mcp-client";
import type {
  CostData,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

type McpTool = Awaited<ReturnType<McpHttpClient["listTools"]>>[number];
type McpClientLike = Pick<McpHttpClient, "initialize" | "listTools" | "callTool">;

interface AiSdkUsageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens?: number;
  reasoningOutputTokens?: number;
  steps: number;
}

export interface AiSdkAgentRunnerResult {
  output?: string;
  usage?: Partial<AiSdkUsageTotals>;
}

export type AiSdkAgentRunner = (opts: {
  config: ProviderSessionConfig;
  model: string;
  tools: ToolSet;
  abortSignal: AbortSignal;
  onTextDelta: (text: string) => void;
  onStepUsage: (usage: LanguageModelUsage) => void;
}) => Promise<AiSdkAgentRunnerResult>;

let aiSdkAgentRunnerForTest: AiSdkAgentRunner | null = null;

export function __setAiSdkAgentRunnerForTest(runner: AiSdkAgentRunner | null): void {
  aiSdkAgentRunnerForTest = runner;
}

export function checkAiSdkAgentCredentials(env: Record<string, string | undefined>): CredStatus {
  if (env.OPENAI_API_KEY) return { ready: true, missing: [], satisfiedBy: "env" };
  return {
    ready: false,
    missing: ["OPENAI_API_KEY"],
    hint: "Set OPENAI_API_KEY for the ai-sdk-agent harness provider.",
  };
}

function usageNumber(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function addUsage(totals: AiSdkUsageTotals, usage: LanguageModelUsage): void {
  totals.inputTokens += usageNumber(usage.inputTokens);
  totals.outputTokens += usageNumber(usage.outputTokens);
  totals.cacheReadTokens += usageNumber(
    usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
  );
  const cacheWrite = usageNumber(usage.inputTokenDetails?.cacheWriteTokens);
  if (cacheWrite > 0) totals.cacheWriteTokens = (totals.cacheWriteTokens ?? 0) + cacheWrite;
  const reasoning = usageNumber(usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens);
  if (reasoning > 0) {
    totals.reasoningOutputTokens = (totals.reasoningOutputTokens ?? 0) + reasoning;
  }
  totals.steps += 1;
}

function textFromMcpResult(result: Awaited<ReturnType<McpHttpClient["callTool"]>>): string {
  const parts = result.content
    .map((part) => (part.type === "text" ? (part.text ?? "") : JSON.stringify(part)))
    .filter(Boolean);
  return parts.length > 0 ? parts.join("\n") : JSON.stringify(result);
}

export function createAiSdkAgentTools(opts: {
  tools: McpTool[];
  client: Pick<McpHttpClient, "callTool">;
  emit: (event: ProviderEvent) => void;
}): ToolSet {
  const result: ToolSet = {};
  for (const mcpTool of opts.tools) {
    const schema = mcpTool.inputSchema ?? { type: "object", additionalProperties: true };
    result[mcpTool.name] = dynamicTool({
      description: mcpTool.description,
      inputSchema: jsonSchema(schema as Parameters<typeof jsonSchema>[0]),
      execute: async (input, options) => {
        const args =
          input && typeof input === "object" && !Array.isArray(input)
            ? (input as Record<string, unknown>)
            : { input };
        const toolCallId = options.toolCallId;
        opts.emit({ type: "tool_start", toolCallId, toolName: mcpTool.name, args });
        try {
          const mcpResult = await opts.client.callTool(mcpTool.name, args);
          const output = textFromMcpResult(mcpResult);
          opts.emit({ type: "tool_end", toolCallId, toolName: mcpTool.name, result: output });
          return output;
        } catch (err) {
          const message = scrubSecrets(err instanceof Error ? err.message : String(err));
          opts.emit({ type: "error", message, category: "tool_error" });
          throw err;
        }
      },
    });
  }
  return result;
}

async function defaultAiSdkAgentRunner(opts: Parameters<AiSdkAgentRunner>[0]) {
  const openai = createOpenAI({
    apiKey: opts.config.env?.OPENAI_API_KEY ?? process.env.OPENAI_API_KEY,
  });
  const agent = new ToolLoopAgent({
    id: `agent-swarm-${opts.config.taskId}`,
    model: openai(opts.model),
    instructions: opts.config.systemPrompt,
    tools: opts.tools,
    stopWhen: stepCountIs(Number(process.env.AI_SDK_AGENT_MAX_STEPS ?? 20)),
  });

  const stream = await agent.stream({
    prompt: opts.config.prompt,
    abortSignal: opts.abortSignal,
    onStepFinish: (step) => opts.onStepUsage(step.usage),
  });

  let output = "";
  for await (const delta of stream.textStream) {
    output += delta;
    opts.onTextDelta(delta);
  }
  const [usage, steps] = await Promise.all([stream.totalUsage, stream.steps]);
  return {
    output,
    usage: {
      inputTokens: usageNumber(usage.inputTokens),
      outputTokens: usageNumber(usage.outputTokens),
      cacheReadTokens: usageNumber(
        usage.inputTokenDetails?.cacheReadTokens ?? usage.cachedInputTokens,
      ),
      cacheWriteTokens: usageNumber(usage.inputTokenDetails?.cacheWriteTokens),
      reasoningOutputTokens: usageNumber(
        usage.outputTokenDetails?.reasoningTokens ?? usage.reasoningTokens,
      ),
      steps: steps.length,
    },
  };
}

function mergeUsageTotals(
  base: AiSdkUsageTotals,
  override: Partial<AiSdkUsageTotals> | undefined,
): AiSdkUsageTotals {
  return {
    inputTokens: override?.inputTokens ?? base.inputTokens,
    outputTokens: override?.outputTokens ?? base.outputTokens,
    cacheReadTokens: override?.cacheReadTokens ?? base.cacheReadTokens,
    cacheWriteTokens: override?.cacheWriteTokens ?? base.cacheWriteTokens,
    reasoningOutputTokens: override?.reasoningOutputTokens ?? base.reasoningOutputTokens,
    steps: override?.steps ?? base.steps,
  };
}

export class AiSdkAgentSession implements ProviderSession {
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private eventQueue: ProviderEvent[] = [];
  private readonly controller = new AbortController();
  private readonly config: ProviderSessionConfig;
  private readonly model: string;
  private readonly logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private readonly completionPromise: Promise<ProviderResult>;
  private readonly startedAt = Date.now();
  private lastAssistantText = "";

  readonly sessionId: string;

  constructor(
    config: ProviderSessionConfig,
    opts: {
      mcpClientFactory?: (config: ProviderSessionConfig) => McpClientLike;
      runner?: AiSdkAgentRunner;
    } = {},
  ) {
    this.config = config;
    this.model = resolveAiSdkAgentModel(config.model);
    this.sessionId = `ai-sdk-agent-${config.taskId}-${Date.now()}`;
    this.logFileHandle = Bun.file(config.logFile).writer();

    const version = readPkgVersion("ai");
    this.emit({
      type: "session_init",
      sessionId: this.sessionId,
      provider: "ai-sdk-agent",
      harnessVariant: "tool-loop-agent",
      ...(version ? { harnessVariantMeta: { version } } : {}),
    });

    this.completionPromise = this.run(opts);
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    while (this.eventQueue.length > 0) {
      const queued = this.eventQueue.shift();
      if (queued) listener(queued);
    }
  }

  waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(reason?: string): Promise<void> {
    const message = reason ?? "aborted";
    this.emit({ type: "progress", message: `[ai-sdk-agent] abort requested: ${message}` });
    this.controller.abort(message);
  }

  private emit(event: ProviderEvent): void {
    const scrubbed: ProviderEvent =
      event.type === "raw_log" || event.type === "raw_stderr" || event.type === "error"
        ? ({
            ...event,
            content: "content" in event ? scrubSecrets(event.content) : undefined,
          } as ProviderEvent)
        : event;
    const finalEvent =
      scrubbed.type === "error"
        ? { ...scrubbed, message: scrubSecrets(scrubbed.message) }
        : scrubbed;

    this.logFileHandle.write(
      `${JSON.stringify({ ...finalEvent, timestamp: new Date().toISOString() })}\n`,
    );
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) listener(finalEvent);
    } else {
      this.eventQueue.push(finalEvent);
    }
  }

  private emitContextUsage(totals: AiSdkUsageTotals, outputTokensDelta: number): void {
    const contextUsedTokens = totals.inputTokens + totals.outputTokens;
    const contextTotalTokens = getAiSdkAgentContextWindow(this.model);
    this.emit({
      type: "context_usage",
      contextUsedTokens,
      contextTotalTokens,
      contextPercent: Math.min(100, (contextUsedTokens / contextTotalTokens) * 100),
      outputTokens: outputTokensDelta,
      contextFormula: "ai-sdk-agent-usage",
    });
  }

  private buildCost(totals: AiSdkUsageTotals, isError: boolean): CostData {
    return {
      sessionId: this.sessionId,
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: computeAiSdkAgentCostUsd(
        this.model,
        totals.inputTokens,
        totals.cacheReadTokens,
        totals.outputTokens,
      ),
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadTokens: totals.cacheReadTokens,
      cacheWriteTokens: totals.cacheWriteTokens,
      reasoningOutputTokens: totals.reasoningOutputTokens,
      durationMs: Date.now() - this.startedAt,
      numTurns: totals.steps > 0 ? totals.steps : null,
      model: this.model,
      isError,
      provider: "ai-sdk-agent",
    };
  }

  private async run(opts: {
    mcpClientFactory?: (config: ProviderSessionConfig) => McpClientLike;
    runner?: AiSdkAgentRunner;
  }): Promise<ProviderResult> {
    const totals: AiSdkUsageTotals = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      steps: 0,
    };
    let previousOutputTokens = 0;
    try {
      const client =
        opts.mcpClientFactory?.(this.config) ??
        new McpHttpClient(
          this.config.apiUrl,
          this.config.apiKey,
          this.config.agentId,
          this.config.taskId,
        );
      await client.initialize();
      const tools = createAiSdkAgentTools({
        tools: await client.listTools(),
        client,
        emit: (event) => this.emit(event),
      });
      tools.Skill = createAiSdkAgentSkillTool({
        client,
        emit: (event) => this.emit(event),
      });
      const runner = opts.runner ?? aiSdkAgentRunnerForTest ?? defaultAiSdkAgentRunner;
      const result = await runner({
        config: this.config,
        model: this.model,
        tools,
        abortSignal: this.controller.signal,
        onTextDelta: (text) => {
          this.lastAssistantText += text;
          this.emit({ type: "message", role: "assistant", content: text });
          this.emit({
            type: "raw_log",
            content: JSON.stringify({ type: "assistant_delta", text }),
          });
        },
        onStepUsage: (usage) => {
          addUsage(totals, usage);
          const outputDelta = Math.max(0, totals.outputTokens - previousOutputTokens);
          previousOutputTokens = totals.outputTokens;
          this.emitContextUsage(totals, outputDelta);
        },
      });
      const finalTotals = mergeUsageTotals(totals, result.usage);
      if (finalTotals.steps > totals.steps) {
        this.emitContextUsage(
          finalTotals,
          Math.max(0, finalTotals.outputTokens - previousOutputTokens),
        );
      }
      const output = result.output ?? (this.lastAssistantText || undefined);
      const cost = this.buildCost(finalTotals, false);
      this.emit({ type: "result", cost, output, isError: false });
      return { exitCode: 0, sessionId: this.sessionId, cost, output, isError: false };
    } catch (err) {
      const message = scrubSecrets(err instanceof Error ? err.message : String(err));
      const cost = this.buildCost(totals, true);
      this.emit({ type: "error", message, category: "api_error" });
      this.emit({
        type: "result",
        cost,
        output: this.lastAssistantText || undefined,
        isError: true,
      });
      return {
        exitCode: 1,
        sessionId: this.sessionId,
        cost,
        output: this.lastAssistantText || undefined,
        isError: true,
        errorCategory: "api_error",
        failureReason: message,
      };
    } finally {
      await this.logFileHandle.end();
    }
  }
}

export class AiSdkAgentAdapter implements ProviderAdapter {
  readonly name = "ai-sdk-agent";
  readonly traits = { hasMcp: true, hasLocalEnvironment: true };

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    return new AiSdkAgentSession(config);
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
