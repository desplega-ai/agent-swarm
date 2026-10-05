import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  McpServerConfig,
  ModelListItem,
  ModelSelection,
  Run,
  SDKAgent,
  SDKMessage,
  TokenUsage,
} from "@cursor/sdk";
import { cursorCatalogRef } from "@desplega/model-catalog";
// Registers the code default of the first-message template.
import "../prompts/session-templates";
import { resolveTemplateAsync, resolveTemplateFromCode } from "../prompts/resolver";
import { DEFAULT_MODEL_TIER_MAP } from "../types";
import { clampContextPercent, getContextWindowSize } from "../utils/context-window";
import { parseEnvFlag } from "../utils/env-flag";
import { swarmRuntimeInstanceId } from "../utils/multi-runtime";
import { registerVolatileSecret, scrubSecrets } from "../utils/secret-scrubber";
import { resolveSlashSkillPrompt } from "./codex-skill-resolver";
import { applyReasoningEffort, type ReasoningEffort } from "./reasoning-effort";
import type {
  CostData,
  CredStatus,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
  SteerDelivery,
  SteerDeliveryResult,
} from "./types";

/** Pinned in package.json and Dockerfile.worker; bump all three together. */
export const CURSOR_SDK_VERSION = "1.0.36";

/** MCP server name; Cursor reports its tools as `mcp` calls with this `providerIdentifier`. */
const CURSOR_MCP_SERVER_NAME = "agent-swarm";

/**
 * Opt in to Cursor's `systemPrompt` (replaces Cursor's own prompt). Cursor
 * enables it per account; without access the run fails naming
 * `--system-prompt`, and the session falls back to the first-message path.
 */
const NATIVE_SYSTEM_PROMPT_ENV = "CURSOR_NATIVE_SYSTEM_PROMPT";

const FIRST_MESSAGE_TEMPLATE = "system.agent.cursor.first_message";

export function checkCursorCredentials(env: Record<string, string | undefined>): CredStatus {
  return env.CURSOR_API_KEY?.trim()
    ? { ready: true, missing: [], satisfiedBy: "env" }
    : { ready: false, missing: ["CURSOR_API_KEY"], hint: "Set CURSOR_API_KEY for cursor." };
}

/**
 * Live credential check for the dashboard's Test connection: `Cursor.me()`
 * authenticates the key without running inference. A bogus key fails with
 * Cursor's own "Invalid User API Key" message.
 */
export async function liveTestCursorKey(
  apiKey: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { Cursor } = await import("@cursor/sdk");
  try {
    await Cursor.me({ apiKey });
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: scrubSecrets(`Cursor rejected CURSOR_API_KEY: ${errorMessage(error)}`),
    };
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

const MODEL_LIST_TTL_MS = 10 * 60_000;
let modelListCache: { key: string; at: number; models: ModelListItem[] } | undefined;

/** `Cursor.models.list()`, cached per key for ten minutes. Account-specific, so never static. */
async function listCursorModels(apiKey: string): Promise<ModelListItem[]> {
  if (modelListCache?.key === apiKey && Date.now() - modelListCache.at < MODEL_LIST_TTL_MS) {
    return modelListCache.models;
  }
  const { Cursor } = await import("@cursor/sdk");
  const models = await Cursor.models.list({ apiKey });
  modelListCache = { key: apiKey, at: Date.now(), models };
  return models;
}

/** Effort parameter ids Cursor models use, most specific first. */
const EFFORT_PARAM_IDS = ["reasoning_effort", "reasoning", "effort"];

/** Cursor's spellings of each normalized level, in preference order. */
const EFFORT_VALUE_ALIASES: Record<ReasoningEffort, string[]> = {
  off: ["none"],
  low: ["low"],
  medium: ["medium"],
  high: ["high"],
  xhigh: ["xhigh", "extra-high"],
  max: ["max"],
};

/**
 * The model selection for `modelId` with `effort` written into the model's
 * own parameter. Pure: `models` is the live `Cursor.models.list()`. Returns
 * the applied level, or null when the model takes no such value (`off` maps
 * to `thinking=false` on models that have a thinking toggle but no `none`).
 */
export function cursorModelSelection(
  modelId: string,
  effort: ReasoningEffort | undefined,
  models: readonly ModelListItem[],
): { selection: ModelSelection; appliedEffort: ReasoningEffort | null } {
  const item = models.find((m) => m.id === modelId || m.aliases?.includes(modelId));
  const selection: ModelSelection = { id: item?.id ?? modelId };
  if (!effort || !item) return { selection, appliedEffort: null };
  const param = item.parameters?.find((p) => EFFORT_PARAM_IDS.includes(p.id));
  const value = param?.values
    .map((v) => v.value)
    .find((v) => EFFORT_VALUE_ALIASES[effort].includes(v));
  if (param && value) {
    selection.params = [{ id: param.id, value }];
    return { selection, appliedEffort: effort };
  }
  const thinking = item.parameters?.find((p) => p.id === "thinking");
  if (effort === "off" && thinking?.values.some((v) => v.value === "false")) {
    selection.params = [{ id: "thinking", value: "false" }];
    return { selection, appliedEffort: effort };
  }
  return { selection, appliedEffort: null };
}

/** Context window for a Cursor model id, from the vendor's catalog row. */
function contextWindowFor(model: string): number | null {
  const { providerId, modelId } = cursorCatalogRef(model);
  return providerId === "cursor" ? null : getContextWindowSize(`${providerId}/${modelId}`);
}

/**
 * Cursor's `inputTokens` includes cache reads (OpenAI semantics: two model
 * calls of ~7.9k prompt each report 15.8k input with 7.7k cache read). The
 * swarm's CostData counts input exclusive of cache reads, so subtract.
 */
function uncachedInput(usage: TokenUsage): number {
  return Math.max(0, usage.inputTokens - usage.cacheReadTokens);
}

/** Folds one SDK message into the swarm's normalized events. Pure. */
export function translateCursorMessage(message: SDKMessage): ProviderEvent[] {
  switch (message.type) {
    case "assistant": {
      const text = message.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      return text ? [{ type: "message", role: "assistant", content: text }] : [];
    }
    case "tool_call": {
      const toolName = cursorToolName(message.name, message.args);
      if (message.status === "running") {
        return [
          { type: "tool_start", toolCallId: message.call_id, toolName, args: message.args ?? {} },
        ];
      }
      return [
        {
          type: "tool_end",
          toolCallId: message.call_id,
          toolName,
          result: message.status === "error" ? { error: message.result } : message.result,
        },
      ];
    }
    case "thinking":
      return [{ type: "custom", name: "cursor_thinking", data: { text: message.text } }];
    case "task":
      return message.text ? [{ type: "progress", message: message.text }] : [];
    default:
      return [];
  }
}

/**
 * Cursor reports every MCP call as tool `mcp` with the server and tool in its
 * args. The runner labels swarm tools by their `mcp__<server>__<tool>` name,
 * as for the claude harness.
 */
function cursorToolName(name: string, args: unknown): string {
  if (name !== "mcp" || !args || typeof args !== "object") return name;
  const { providerIdentifier, toolName } = args as {
    providerIdentifier?: unknown;
    toolName?: unknown;
  };
  if (typeof toolName !== "string" || !toolName) return name;
  return `mcp__${typeof providerIdentifier === "string" && providerIdentifier ? providerIdentifier : CURSOR_MCP_SERVER_NAME}__${toolName}`;
}

/** What the adapter resolved before the first send. */
interface CursorRunInfo {
  model: ModelSelection;
  appliedEffort: ReasoningEffort | null;
  taskId: string;
  agentId: string;
  /** Recreates the agent without `systemPrompt` (the first-message fallback). */
  recreateWithoutSystemPrompt?: () => Promise<SDKAgent>;
  systemPrompt: string;
}

/** The first-message path: Cursor keeps its own system prompt, the swarm's rides on top. */
export async function composeFirstMessage(systemPrompt: string, prompt: string): Promise<string> {
  if (!systemPrompt.trim()) return prompt;
  const variables = { systemPrompt, prompt };
  try {
    const result = await resolveTemplateAsync(FIRST_MESSAGE_TEMPLATE, variables);
    if (!result.skipped && result.text.trim()) return result.text;
  } catch {
    // Fall through to the code default.
  }
  // A skipped, blank, or failing override must not drop the system prompt.
  return resolveTemplateFromCode(FIRST_MESSAGE_TEMPLATE, variables).text;
}

/** Cursor's error when the account has no access to `systemPrompt`. */
function isSystemPromptUnavailable(message: string | undefined): boolean {
  return Boolean(message?.includes("--system-prompt"));
}

const QUEUE_NOT_SENT = "cursor session ended before the queued message was sent";

/**
 * A message waiting for the next run. `settle` resolves its
 * `deliverSteering()` call: delivered once Cursor accepts the run carrying
 * it, undeliverable when the session ends first.
 */
interface QueuedDelivery {
  text: string;
  settle: (result: SteerDeliveryResult) => void;
}

class CursorSession implements ProviderSession {
  sessionId: string | undefined;
  private listeners: ((event: ProviderEvent) => void)[] = [];
  private pending: ProviderEvent[] = [];
  private readonly startedAt = Date.now();
  private readonly contextWindow: number | null;
  private currentRun: Run | undefined;
  private queue: QueuedDelivery[] = [];
  private ended = false;
  private aborted = false;
  private usage: TokenUsage | undefined;
  private runs = 0;
  private output: string | undefined;
  private failure: string | undefined;
  private assistantText = "";
  private completion: Promise<ProviderResult>;

  constructor(
    private agent: SDKAgent,
    firstMessage: string,
    private readonly info: CursorRunInfo,
    private readonly directory: string,
  ) {
    this.contextWindow = contextWindowFor(info.model.id);
    this.announce(info.recreateWithoutSystemPrompt ? "native" : "first-message");
    this.completion = this.run(firstMessage);
  }

  /** Reports the agent in use: its session id and how the swarm prompt reaches it. */
  private announce(systemPrompt: "native" | "first-message"): void {
    this.sessionId = this.agent.agentId;
    this.emit({ type: "session_init", sessionId: this.agent.agentId, provider: "cursor" });
    this.emit({
      type: "raw_log",
      content: JSON.stringify({
        type: "model",
        provider: "cursor",
        model: this.info.model,
        systemPrompt,
      }),
    });
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    for (const event of this.pending.splice(0)) listener(event);
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length === 0) this.pending.push(event);
    else for (const listener of this.listeners) listener(event);
  }

  /** Cursor streams assistant text in small chunks; emit one message per text run. */
  private flushText(): void {
    if (!this.assistantText) return;
    this.emit({ type: "message", role: "assistant", content: this.assistantText });
    this.assistantText = "";
  }

  private handle(message: SDKMessage): void {
    this.emit({ type: "raw_log", content: scrubSecrets(JSON.stringify(message)) });
    if (message.type === "status" && message.status === "ERROR" && message.message) {
      this.failure = scrubSecrets(message.message);
    }
    for (const event of translateCursorMessage(message)) {
      if (event.type === "message") {
        this.assistantText += event.content;
        continue;
      }
      this.flushText();
      this.emit(event);
    }
  }

  /**
   * Cursor reports usage once per run, summed over every model call in it,
   * and no per-call figure. The run's model calls are its tool rounds plus
   * the final reply, so the per-call average stands in for the context in
   * use. Prompts grow within a run, so it under-reads the last call; tagged
   * `peak-proxy` rather than the exact unified formula.
   */
  private recordRun(usage: TokenUsage, toolRounds: number): void {
    const calls = toolRounds + 1;
    const used = Math.round(
      (usage.inputTokens + usage.cacheWriteTokens + usage.outputTokens) / calls,
    );
    if (used <= 0) return;
    this.emit({
      type: "context_usage",
      contextUsedTokens: used,
      contextTotalTokens: this.contextWindow,
      contextPercent: clampContextPercent(used, this.contextWindow),
      outputTokens: Math.round(usage.outputTokens / calls),
      contextFormula: "peak-proxy",
    });
  }

  private addUsage(usage: TokenUsage | undefined): void {
    if (!usage) return;
    const prev = this.usage;
    this.usage = prev
      ? {
          inputTokens: prev.inputTokens + usage.inputTokens,
          outputTokens: prev.outputTokens + usage.outputTokens,
          cacheReadTokens: prev.cacheReadTokens + usage.cacheReadTokens,
          cacheWriteTokens: prev.cacheWriteTokens + usage.cacheWriteTokens,
          totalTokens: prev.totalTokens + usage.totalTokens,
          reasoningTokens: (prev.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
        }
      : { ...usage };
  }

  private buildCost(isError: boolean): CostData | undefined {
    if (!this.sessionId || !this.usage) return undefined;
    return {
      sessionId: this.sessionId,
      taskId: this.info.taskId,
      agentId: this.info.agentId,
      // Cursor bills the vendor's API rates, and `agent.getUsage()` (billed
      // cents) is not available for local agents, so the API prices the
      // tokens from the cursor pricing rows.
      totalCostUsd: 0,
      inputTokens: uncachedInput(this.usage),
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens,
      reasoningOutputTokens: this.usage.reasoningTokens || undefined,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.runs,
      model: this.info.model.id,
      isError,
      provider: "cursor",
    };
  }

  /**
   * Sends one message as a run and drains it. Returns the run's terminal
   * status. `onAccepted` fires once Cursor has accepted the run and the
   * session is still live. An abort before or during `send()` cancels the
   * run instead of streaming it, since `abort()` had no run to cancel yet.
   */
  private async sendAndDrain(
    text: string,
    onAccepted?: () => void,
  ): Promise<"finished" | "error" | "cancelled"> {
    if (this.aborted) return "cancelled";
    let toolRounds = 0;
    const run = await this.agent.send(text, {
      // One `tool-requests-listed` per model call that asked for tools.
      onDelta: ({ update }) => {
        if (update.type === "tool-requests-listed") toolRounds += 1;
      },
    });
    this.currentRun = run;
    this.runs += 1;
    if (this.aborted) {
      await run.cancel().catch(() => {});
      const result = await run.wait().catch(() => undefined);
      this.addUsage(result?.usage);
      return "cancelled";
    }
    onAccepted?.();
    for await (const message of run.stream()) this.handle(message);
    this.flushText();
    const result = await run.wait();
    this.addUsage(result.usage);
    if (result.usage) this.recordRun(result.usage, toolRounds);
    if (result.result) this.output = result.result;
    if (result.status === "error") {
      this.failure = scrubSecrets(result.error?.message ?? this.failure ?? "cursor run failed");
    }
    return result.status;
  }

  private async run(firstMessage: string): Promise<ProviderResult> {
    try {
      let status = await this.sendAndDrain(firstMessage);
      if (
        status === "error" &&
        this.runs === 1 &&
        !this.aborted &&
        isSystemPromptUnavailable(this.failure)
      ) {
        // The account has no `systemPrompt` access: rebuild the agent without
        // it and carry the swarm prompt in the first message instead.
        const recreate = this.info.recreateWithoutSystemPrompt;
        if (recreate) {
          this.emit({
            type: "progress",
            message: "Cursor systemPrompt unavailable for this account; using the first message",
          });
          this.agent.close();
          this.agent = await recreate();
          this.announce("first-message");
          this.failure = undefined;
          this.output = undefined;
          this.runs = 0;
          status = await this.sendAndDrain(
            await composeFirstMessage(this.info.systemPrompt, firstMessage),
          );
        }
      }
      while (status === "finished" && !this.aborted) {
        const next = this.queue.shift();
        if (next === undefined) break;
        try {
          status = await this.sendAndDrain(next.text, () =>
            next.settle({ delivered: true, mode: "queue" }),
          );
        } finally {
          next.settle({ delivered: false, reason: QUEUE_NOT_SENT });
        }
      }
      this.ended = true;
      const isError = this.aborted || status !== "finished";
      const failureReason = isError
        ? this.aborted || status === "cancelled"
          ? "cursor session aborted"
          : this.failure || `cursor run ended with status ${status}`
        : undefined;
      if (failureReason) this.emit({ type: "error", message: failureReason });
      const cost = this.buildCost(isError);
      if (cost) this.emit({ type: "result", cost, output: this.output, isError });
      return {
        exitCode: isError ? 1 : 0,
        sessionId: this.sessionId,
        cost,
        output: this.output,
        isError,
        failureReason,
        appliedReasoningEffort: this.info.appliedEffort,
      };
    } catch (error) {
      this.ended = true;
      const failureReason = scrubSecrets(errorMessage(error));
      this.emit({ type: "error", message: failureReason });
      return {
        exitCode: 1,
        sessionId: this.sessionId,
        cost: this.buildCost(true),
        isError: true,
        failureReason,
        appliedReasoningEffort: this.info.appliedEffort,
      };
    } finally {
      this.ended = true;
      this.settleQueued(QUEUE_NOT_SENT);
      this.agent.close();
      await rm(this.directory, { recursive: true, force: true });
    }
  }

  /** Reports every unsent queued message undeliverable, so the server promotes it to a follow-up. */
  private settleQueued(reason: string): void {
    for (const item of this.queue.splice(0)) item.settle({ delivered: false, reason });
  }

  waitForCompletion(): Promise<ProviderResult> {
    return this.completion;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.settleQueued("cursor session aborted before the queued message was sent");
    const run = this.currentRun;
    if (run && run.status === "running") await run.cancel().catch(() => {});
  }

  async deliverSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
    if (this.ended || this.aborted) {
      return { delivered: false, reason: "cursor session already completed" };
    }
    const run = this.currentRun;
    if (mode === "steer" && run?.steer && run.status === "running") {
      try {
        const outcome = await run.steer(text);
        if (outcome === "complete_delivered") return { delivered: true, mode: "steer" };
      } catch (error) {
        return { delivered: false, reason: scrubSecrets(errorMessage(error)) };
      }
      // `revert_to_followup`: the run could not take it mid-turn.
    }
    if (this.ended || this.aborted) {
      return { delivered: false, reason: "cursor session already completed" };
    }
    // Resolves when the next run carrying `text` is accepted, or as
    // undeliverable if the session ends first.
    return new Promise((resolve) => {
      let settled = false;
      this.queue.push({
        text,
        settle: (result) => {
          if (settled) return;
          settled = true;
          resolve(result);
        },
      });
    });
  }
}

export class CursorAdapter implements ProviderAdapter {
  readonly name = "cursor";
  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasToolSearch: false,
    // The SDK reads workspace skills itself, but not the swarm's skills
    // tree, so the system prompt lists them (as for codex and dsh).
    nativeSkillDiscovery: false,
    hasLocalEnvironment: true,
    steerModes: ["steer", "queue"],
  };

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const env = { ...process.env, ...config.env };
    const apiKey = env.CURSOR_API_KEY?.trim();
    if (!apiKey) throw new Error("cursor requires CURSOR_API_KEY");
    registerVolatileSecret(apiKey, "CURSOR_API_KEY");
    const { Agent, JsonlLocalAgentStore } = await import("@cursor/sdk");

    const modelId = config.model || DEFAULT_MODEL_TIER_MAP.cursor.regular;
    const effort = applyReasoningEffort("cursor", modelId, config.reasoningEffort);
    const requested = effort.kind === "cursor-effort" ? effort.reasoningEffort : undefined;
    let models: ModelListItem[] = [];
    try {
      models = await listCursorModels(apiKey);
    } catch {
      // The model list only resolves aliases and effort; the run reports a bad key.
    }
    const { selection, appliedEffort } = cursorModelSelection(modelId, requested, models);

    const prompt = await resolveSlashSkillPrompt(config.prompt, {
      providerLabel: "cursor",
      skillsDir: join(env.HOME ?? "/home/worker", ".agents", "skills"),
    });
    const runtimeInstanceId = swarmRuntimeInstanceId();
    const swarmMcp: McpServerConfig = {
      type: "http",
      url: `${config.apiUrl}/mcp`,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "X-Agent-ID": config.agentId,
        "X-Source-Task-Id": config.taskId,
        ...(config.contextKey ? { "X-Context-Key": config.contextKey } : {}),
        ...(runtimeInstanceId ? { "X-Runtime-Instance-ID": runtimeInstanceId } : {}),
      },
    };
    // Per-session JSONL store: no conversation state outlives the task.
    const directory = await mkdtemp(join(tmpdir(), "swarm-cursor-"));
    const nativeSystemPrompt = parseEnvFlag(env[NATIVE_SYSTEM_PROMPT_ENV], false);
    const create = (withSystemPrompt: boolean) =>
      Agent.create({
        apiKey,
        model: selection,
        name: `swarm-${config.taskId}`,
        mcpServers: { [CURSOR_MCP_SERVER_NAME]: swarmMcp },
        ...(withSystemPrompt && config.systemPrompt ? { systemPrompt: config.systemPrompt } : {}),
        local: {
          cwd: config.cwd,
          store: new JsonlLocalAgentStore(directory),
          // The worker container is the sandbox, as for codex and dsh.
          sandboxOptions: { enabled: false },
        },
      });
    try {
      const agent = await create(nativeSystemPrompt);
      return new CursorSession(
        agent,
        nativeSystemPrompt ? prompt : await composeFirstMessage(config.systemPrompt, prompt),
        {
          model: selection,
          appliedEffort,
          taskId: config.taskId,
          agentId: config.agentId,
          systemPrompt: config.systemPrompt,
          recreateWithoutSystemPrompt: nativeSystemPrompt ? () => create(false) : undefined,
        },
        directory,
      );
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw new Error(scrubSecrets(`cursor agent create failed: ${errorMessage(error)}`));
    }
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
