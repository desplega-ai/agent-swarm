/**
 * ClaudeManagedAdapter — harness provider for Anthropic's Managed Agents
 * (`@anthropic-ai/sdk` beta surface).
 *
 * **Phase 3 status**: real session lifecycle. `createSession` opens (or resumes)
 * a managed session, sends the composed user message, streams `events.stream`
 * SSE events, and translates them into the cross-provider `ProviderEvent` union.
 * `abort()` interrupts + archives. `canResume()` retrieves the session and
 * inspects its status.
 *
 * Reference: thoughts/taras/plans/2026-04-28-claude-managed-agents-provider.md
 *
 * ### SDK shape notes (verified against
 * `node_modules/@anthropic-ai/sdk/resources/beta/sessions/*.d.ts` on
 * `@anthropic-ai/sdk@latest` (post-bump)):
 *
 * - Event types are dot-separated tags: `agent.message`, `agent.tool_use`,
 *   `agent.mcp_tool_use`, `agent.tool_result`, `agent.mcp_tool_result`,
 *   `agent.thinking`, `agent.thread_context_compacted`, `span.model_request_end`,
 *   `session.status_running`, `session.status_idle`, `session.status_terminated`,
 *   `session.error`, `session.deleted`, etc.
 * - Session status field is `'rescheduling' | 'running' | 'idle' | 'terminated'`.
 *   "Archived" is not a status — it's signaled by `archived_at !== null`.
 *   `canResume` therefore rejects only `terminated` sessions and sessions whose
 *   `archived_at` is non-null.
 * - `events.send` takes `{ events: [...] }` — an array, NOT a single event arg.
 * - `events.stream` returns a `Stream<BetaManagedAgentsStreamSessionEvents>`
 *   which is an `AsyncIterable`.
 * - `events.list` returns a `PagePromise` which is also `AsyncIterable` over
 *   `BetaManagedAgentsSessionEvent`.
 * - `BetaManagedAgentsTextBlock` does NOT have a `cache_control` field in its
 *   TS definition — but the API does honor it (per the prompt-caching beta).
 *   We attach it via a typed extension and cast on the way out so the runtime
 *   payload includes it; the type-level `cache_control` annotation is captured
 *   in `BetaManagedAgentsTextBlock`.
 */

import Anthropic from "@anthropic-ai/sdk";
// Real type usages (the Phase 1 imports become non-decorative as of this phase).
import type { BetaManagedAgentsAgent as Agent } from "@anthropic-ai/sdk/resources/beta/agents";
import type { BetaEnvironment as Environment } from "@anthropic-ai/sdk/resources/beta/environments";
import type {
  BetaManagedAgentsAgentMCPToolResultEvent,
  BetaManagedAgentsAgentMCPToolUseEvent,
  BetaManagedAgentsAgentMessageEvent,
  BetaManagedAgentsAgentThinkingEvent,
  BetaManagedAgentsAgentThreadContextCompactedEvent,
  BetaManagedAgentsAgentToolResultEvent,
  BetaManagedAgentsAgentToolUseEvent,
  BetaManagedAgentsSessionErrorEvent,
  BetaManagedAgentsSessionStatusIdleEvent,
  BetaManagedAgentsSessionStatusTerminatedEvent,
  BetaManagedAgentsSpanModelRequestEndEvent,
  BetaManagedAgentsStreamSessionEvents,
  BetaManagedAgentsTextBlock,
  BetaManagedAgentsSession as Session,
  BetaManagedAgentsSessionEvent as SessionEvent,
} from "@anthropic-ai/sdk/resources/beta/sessions";
import type { SkillCreateResponse as Skill } from "@anthropic-ai/sdk/resources/beta/skills";

import { checkToolLoop } from "../hooks/tool-loop-detection";
import { scrubSecrets } from "../utils/secret-scrubber";
import { computeClaudeManagedCostUsd } from "./claude-managed-models";
import { createClaudeManagedSwarmEventHandler } from "./claude-managed-swarm-events";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

// Re-export the type aliases at module level so adjacent files / tests can use
// the short names without re-discovering the long Beta-prefixed ones. Kept on
// `void` lines so unused-import lints stay quiet for the type imports above.
void (null as unknown as Agent);
void (null as unknown as Environment);
void (null as unknown as Skill);

/**
 * Required env vars validated at construction time. Listing them in one place
 * keeps the error messages consistent and makes it easy for Phase 2 (worker
 * bootstrap / docker-entrypoint) to mirror the validation.
 */
const REQUIRED_ENV_VARS = [
  "ANTHROPIC_API_KEY",
  "MANAGED_AGENT_ID",
  "MANAGED_ENVIRONMENT_ID",
] as const;

/**
 * Default context window for managed Claude sessions when we don't have a
 * model-specific override. Sized to match Sonnet 4.x (1M extended-context
 * variant). The Phase 4 pricing-table commit will replace this with a
 * per-model lookup.
 */
const DEFAULT_CONTEXT_TOTAL_TOKENS = 1_000_000;

/**
 * Compose the per-session user-message content blocks. Returns two blocks:
 *
 *   1. A static prefix — agent identity + composed system prompt. Must be
 *      byte-identical across two different `config` inputs that share the
 *      same `agentId` so the managed-agents service can dedupe / cache it
 *      server-side.
 *   2. The per-task body — `User request:\n${config.prompt}`.
 *
 * Exported (named) so unit tests can assert the static-prefix invariant.
 *
 * NOTE: An earlier revision attached `cache_control: { type: "ephemeral" }`
 * to block #1 to manually mark a prompt-cache breakpoint, but the
 * managed-agents `events.send` endpoint rejects unknown fields with
 * `events.0.content.0.cache_control: Extra inputs are not permitted`.
 * Caching is handled server-side; we only control the static-prefix shape.
 */
export function composeManagedUserMessage(
  config: Pick<ProviderSessionConfig, "agentId" | "systemPrompt" | "prompt">,
): BetaManagedAgentsTextBlock[] {
  const staticPrefix = `[swarm worker] agentId=${config.agentId}\n\n` + `${config.systemPrompt}`;

  return [
    {
      type: "text",
      text: staticPrefix,
    },
    {
      type: "text",
      text: `---\n\nUser request:\n${config.prompt}`,
    },
  ];
}

/**
 * Normalize the runner's `vcsRepo` (which may be `"owner/repo"` shorthand or
 * a fully-qualified `https://...` URL — see `src/types.ts:136` and
 * `src/commands/runner.ts:3185-3192`) to a fully-qualified GitHub HTTPS URL,
 * which is what the managed-agents `BetaManagedAgentsGitHubRepositoryResourceParams.url`
 * field expects. Pass-through if already a URL.
 */
export function normalizeRepoUrl(vcsRepo: string): string {
  if (vcsRepo.startsWith("http://") || vcsRepo.startsWith("https://")) {
    return vcsRepo;
  }
  return `https://github.com/${vcsRepo}`;
}

/**
 * Build the empty-zero `CostData` shape used at the start of a session and
 * mutated in-place as `span.model_request_end` events accumulate token counts.
 */
function emptyCost(config: ProviderSessionConfig, model: string): CostData {
  return {
    sessionId: "",
    taskId: config.taskId,
    agentId: config.agentId,
    totalCostUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
    numTurns: 0,
    model,
    isError: false,
  };
}

/**
 * Subset of the Anthropic client surface this adapter consumes. Captured as an
 * interface so unit tests can substitute a small fake without dragging in the
 * full SDK.
 */
export interface ManagedAgentsClient {
  beta: {
    sessions: {
      create: (params: Record<string, unknown>) => Promise<Session> | Session;
      retrieve: (sessionId: string) => Promise<Session> | Session;
      archive: (sessionId: string) => Promise<Session> | Session;
      events: {
        stream: (
          sessionId: string,
        ) =>
          | Promise<AsyncIterable<BetaManagedAgentsStreamSessionEvents>>
          | AsyncIterable<BetaManagedAgentsStreamSessionEvents>;
        send: (
          sessionId: string,
          params: { events: Array<Record<string, unknown>> },
        ) => Promise<unknown>;
        list: (
          sessionId: string,
        ) => Promise<AsyncIterable<SessionEvent>> | AsyncIterable<SessionEvent>;
      };
    };
  };
}

/**
 * Running session backed by a managed-agents `Session`. Mirrors `CodexSession`:
 * owns the SSE consumer, the JSONL log file handle, the abort controller, the
 * cost accumulator, and the listener buffer.
 */
class ClaudeManagedSession implements ProviderSession {
  private readonly client: ManagedAgentsClient;
  private readonly _sessionId: string;
  private readonly userMessageContent: BetaManagedAgentsTextBlock[] | null;
  private readonly listeners: Array<(event: ProviderEvent) => void> = [];
  private readonly eventQueue: ProviderEvent[] = [];
  private readonly logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private readonly startedAt = Date.now();
  private readonly completionPromise: Promise<ProviderResult>;
  private resolveCompletion!: (result: ProviderResult) => void;
  private readonly abortController = new AbortController();
  private readonly seenEventIds: Set<string>;
  private readonly cost: CostData;
  /** Per-task taskId — captured for `checkToolLoop` lookups. */
  private readonly taskId: string | null;
  private aborted = false;
  private settled = false;

  constructor(
    client: ManagedAgentsClient,
    sessionId: string,
    config: ProviderSessionConfig,
    userMessageContent: BetaManagedAgentsTextBlock[] | null,
    seenEventIds: Set<string> = new Set(),
  ) {
    this.client = client;
    this._sessionId = sessionId;
    this.userMessageContent = userMessageContent;
    this.seenEventIds = seenEventIds;
    this.cost = emptyCost(config, config.model);
    this.taskId = config.taskId;
    this.logFileHandle = Bun.file(config.logFile).writer();
    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

    // Phase 5: adapter-side swarm hooks. Lower-latency cancellation poll,
    // tool-loop detection (the handler also calls `checkToolLoop` on
    // tool_start; we additionally call it inline below for the blocked-result
    // emit), heartbeat, activity ping, and context-usage reporting. Skipped
    // when there's no task or API context to talk to.
    if (config.taskId && config.apiUrl && config.apiKey) {
      const abortRef = { current: this.abortController };
      const handler = createClaudeManagedSwarmEventHandler({
        apiUrl: config.apiUrl,
        apiKey: config.apiKey,
        agentId: config.agentId,
        taskId: config.taskId,
        abortRef,
        client: this.client,
        managedSessionId: this._sessionId,
      });
      this.listeners.push(handler);
    }

    // Kick the SSE loop asynchronously so the constructor can return.
    void this.runSession();
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    for (const event of this.eventQueue) {
      try {
        listener(event);
      } catch {
        // Bad listener must not kill the session.
      }
    }
    this.eventQueue.length = 0;
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  /**
   * Idempotent abort. Sets the local flag, fires the abort controller (which
   * unblocks any awaiting SDK calls), then sends `user.interrupt` and archives
   * the managed session out-of-band — the SSE loop's catch path emits the
   * terminal `result` event and settles the completion promise.
   */
  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.abortController.abort();
    // Fire-and-forget interrupt + archive. We don't block the caller on these
    // round-trips; the SSE loop (or its catch path) settles the promise.
    void this.client.beta.sessions.events
      .send(this._sessionId, {
        events: [{ type: "user.interrupt" }],
      })
      .catch(() => {
        // Already-archived / already-terminated sessions return errors here.
        // Swallow — the cancel intent is recorded in `aborted`.
      });
    void Promise.resolve(this.client.beta.sessions.archive(this._sessionId)).catch(() => {
      // Same — best-effort.
    });
  }

  /**
   * Central event emit — runs `scrubSecrets` over `raw_log`/`raw_stderr`
   * content before any egress (log file write OR listener dispatch). Mirrors
   * `CodexSession.emit` (codex-adapter.ts:347-374). Kept private; this class
   * is the only emitter.
   */
  private emit(event: ProviderEvent): void {
    const scrubbed: ProviderEvent =
      event.type === "raw_log" || event.type === "raw_stderr"
        ? { ...event, content: scrubSecrets(event.content) }
        : event;
    try {
      this.logFileHandle.write(
        `${JSON.stringify({ ...scrubbed, timestamp: new Date().toISOString() })}\n`,
      );
    } catch {
      // Log writer failure must not break the event stream.
    }
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(scrubbed);
        } catch {
          // Swallow listener errors.
        }
      }
    } else {
      this.eventQueue.push(scrubbed);
    }
  }

  private settle(result: ProviderResult): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveCompletion(result);
  }

  /**
   * Build the terminal `CostData` snapshot.
   *
   * Phase 4 wires real USD pricing:
   * 1. Per-token cost via `computeClaudeManagedCostUsd` (looks up the per-Mtok
   *    rates in `claude-managed-models.ts`).
   * 2. Anthropic's $0.08/session-hour runtime fee — billed continuously by
   *    Anthropic regardless of model usage, so we add it here to surface in
   *    the swarm's per-session cost UI.
   */
  private snapshotCost(isError: boolean): CostData {
    const durationMs = Date.now() - this.startedAt;
    const tokenCostUsd = computeClaudeManagedCostUsd(
      this.cost.model,
      this.cost.inputTokens ?? 0,
      this.cost.outputTokens ?? 0,
      this.cost.cacheReadTokens ?? 0,
      this.cost.cacheWriteTokens ?? 0,
    );
    // $0.08 / session-hour. Sandbox runtime is billed by wallclock, so we
    // amortize linearly across the session's `durationMs`.
    const runtimeFeeUsd = (durationMs / 3_600_000) * 0.08;
    return {
      ...this.cost,
      durationMs,
      isError,
      totalCostUsd: tokenCostUsd + runtimeFeeUsd,
    };
  }

  /**
   * Tool-loop detection: fires asynchronously alongside each `tool_start`
   * emit. If `checkToolLoop` reports `blocked: true`, we surface the reason
   * via `raw_stderr` and trigger `abortController.abort()` — the SSE loop's
   * AbortError catch path emits the cancelled `result` and settles.
   *
   * Made non-blocking so the SSE for-await loop stays synchronous in the hot
   * path. Errors from `checkToolLoop` (file I/O on `/tmp`) are swallowed —
   * loop detection failure must never kill a real session.
   */
  private runToolLoopCheck(toolName: string, args: unknown): void {
    if (!this.taskId) return;
    const argRecord = args && typeof args === "object" ? (args as Record<string, unknown>) : {};
    void checkToolLoop(this.taskId, toolName, argRecord)
      .then((result) => {
        if (result.blocked) {
          this.emit({
            type: "raw_stderr",
            content: `[claude-managed] Tool-loop detection blocked further calls: ${result.reason ?? "(no reason given)"}\n`,
          });
          this.abortController.abort();
        }
      })
      .catch(() => {});
  }

  /**
   * Translate one Anthropic SSE event into zero-or-more `ProviderEvent`s.
   * Returns `true` if the event was a terminal session-status (idle /
   * terminated) — caller breaks the SSE loop on `true`.
   */
  private handleEvent(event: BetaManagedAgentsStreamSessionEvents): {
    terminal: boolean;
    isError: boolean;
    assistantText?: string;
  } {
    // Always raw-log first (mirrors codex-adapter.ts:467).
    this.emit({ type: "raw_log", content: JSON.stringify(event) });

    let assistantText: string | undefined;

    switch (event.type) {
      case "agent.message": {
        const msg = event as BetaManagedAgentsAgentMessageEvent;
        const text = msg.content.map((block) => block.text).join("");
        if (text) {
          this.emit({ type: "message", role: "assistant", content: text });
          assistantText = text;
        }
        return { terminal: false, isError: false, assistantText };
      }
      case "agent.tool_use": {
        const tu = event as BetaManagedAgentsAgentToolUseEvent;
        this.runToolLoopCheck(tu.name, tu.input);
        this.emit({
          type: "tool_start",
          toolCallId: tu.id,
          toolName: tu.name,
          args: tu.input,
        });
        return { terminal: false, isError: false };
      }
      case "agent.mcp_tool_use": {
        const tu = event as BetaManagedAgentsAgentMCPToolUseEvent;
        const fqToolName = `${tu.mcp_server_name}:${tu.name}`;
        this.runToolLoopCheck(fqToolName, tu.input);
        this.emit({
          type: "tool_start",
          toolCallId: tu.id,
          toolName: fqToolName,
          args: tu.input,
        });
        return { terminal: false, isError: false };
      }
      case "agent.tool_result": {
        const tr = event as BetaManagedAgentsAgentToolResultEvent;
        this.emit({
          type: "tool_end",
          toolCallId: tr.tool_use_id,
          // We don't have the tool name on the result event itself — the
          // dashboard already keys off `toolCallId` to pair start/end, so
          // passing through an empty string here is fine.
          toolName: "",
          result: { content: tr.content ?? [], isError: tr.is_error ?? false },
        });
        return { terminal: false, isError: false };
      }
      case "agent.mcp_tool_result": {
        const tr = event as BetaManagedAgentsAgentMCPToolResultEvent;
        this.emit({
          type: "tool_end",
          toolCallId: tr.mcp_tool_use_id,
          toolName: "",
          result: { content: tr.content ?? [], isError: tr.is_error ?? false },
        });
        return { terminal: false, isError: false };
      }
      case "agent.thinking": {
        const th = event as BetaManagedAgentsAgentThinkingEvent;
        this.emit({
          type: "custom",
          name: "claude-managed.thinking",
          data: { id: th.id, processedAt: th.processed_at },
        });
        return { terminal: false, isError: false };
      }
      case "agent.thread_context_compacted": {
        // The SDK doesn't currently expose pre/post-compact token counts on
        // this event. Emit a `compaction` ProviderEvent with the values we
        // *do* know; consumers that need richer data can subscribe to
        // `raw_log` for the original payload.
        const _cc = event as BetaManagedAgentsAgentThreadContextCompactedEvent;
        this.emit({
          type: "compaction",
          preCompactTokens: this.cost.inputTokens ?? 0,
          compactTrigger: "auto",
          contextTotalTokens: DEFAULT_CONTEXT_TOTAL_TOKENS,
        });
        return { terminal: false, isError: false };
      }
      case "span.model_request_end": {
        const sp = event as BetaManagedAgentsSpanModelRequestEndEvent;
        const usage = sp.model_usage;
        this.cost.inputTokens = (this.cost.inputTokens ?? 0) + usage.input_tokens;
        this.cost.outputTokens = (this.cost.outputTokens ?? 0) + usage.output_tokens;
        this.cost.cacheReadTokens =
          (this.cost.cacheReadTokens ?? 0) + usage.cache_read_input_tokens;
        this.cost.cacheWriteTokens =
          (this.cost.cacheWriteTokens ?? 0) + usage.cache_creation_input_tokens;
        this.cost.numTurns += 1;

        const used = (this.cost.inputTokens ?? 0) + (this.cost.outputTokens ?? 0);
        const total = DEFAULT_CONTEXT_TOTAL_TOKENS;
        this.emit({
          type: "context_usage",
          contextUsedTokens: used,
          contextTotalTokens: total,
          contextPercent: Math.min(100, (used / total) * 100),
          outputTokens: this.cost.outputTokens ?? 0,
        });
        return { terminal: false, isError: false };
      }
      case "session.status_running":
      case "session.status_rescheduled":
      case "span.model_request_start":
      case "session.deleted":
      case "user.message":
      case "user.interrupt":
      case "user.tool_confirmation":
      case "user.custom_tool_result":
      case "agent.custom_tool_use": {
        // No-op for Phase 3. Future phases may surface these as `progress`
        // events (the dashboard tracks status transitions today via
        // `session_init` + `result` only).
        return { terminal: false, isError: false };
      }
      case "session.error": {
        const se = event as BetaManagedAgentsSessionErrorEvent;
        this.emit({
          type: "error",
          message: se.error.message,
          category: "managed_agent_error",
        });
        // Only the `terminal` retry status fully kills the session. Other
        // states (`retrying`, `exhausted`) are non-fatal; we let the stream
        // continue and rely on `status_terminated` / `status_idle` for the
        // terminal hand-off.
        const fatal = se.error.retry_status?.type === "terminal";
        return { terminal: fatal, isError: true };
      }
      case "session.status_terminated": {
        const _t = event as BetaManagedAgentsSessionStatusTerminatedEvent;
        return { terminal: true, isError: true };
      }
      case "session.status_idle": {
        const _i = event as BetaManagedAgentsSessionStatusIdleEvent;
        return { terminal: true, isError: false };
      }
      default: {
        // SDK occasionally adds new event variants. Surface the unknown via
        // raw_log only — already done at the top of the function.
        return { terminal: false, isError: false };
      }
    }
  }

  /**
   * The SSE consumer. Opens the stream BEFORE sending the user message so we
   * never miss the agent's response (race-safe ordering, per the quickstart
   * docs: https://platform.claude.com/docs/en/managed-agents/quickstart).
   */
  private async runSession(): Promise<void> {
    let lastAssistantText: string | undefined;
    let saw_terminal = false;
    let isError = false;

    try {
      // 1. Open the stream first.
      const stream = await Promise.resolve(
        this.client.beta.sessions.events.stream(this._sessionId),
      );

      // 2. Send the user message (skipped on resume — `userMessageContent`
      //    is null then).
      if (this.userMessageContent) {
        await this.client.beta.sessions.events.send(this._sessionId, {
          events: [
            {
              type: "user.message",
              content: this.userMessageContent as unknown as Record<string, unknown>[],
            },
          ],
        });
      }

      // 3. Emit `session_init` once the session is wired up. Listeners
      //    attached via `onEvent` will see this either immediately (if they
      //    attached pre-emit) or via the queue flush.
      this.emit({
        type: "session_init",
        sessionId: this._sessionId,
        provider: "claude" as const,
        providerMeta: { managed: true },
      });

      // 4. Drain the SSE stream.
      try {
        for await (const event of stream) {
          // Phase 5: external abort (swarm-events poll, tool-loop detection)
          // can fire `abortController.abort()` without crashing the SSE
          // stream. Bail proactively so the cancel path runs.
          if (this.abortController.signal.aborted) {
            throw Object.assign(new Error("aborted"), { name: "AbortError" });
          }
          // Resume dedup: skip events we already saw via `events.list`.
          if (this.seenEventIds.size > 0 && "id" in event && event.id) {
            if (this.seenEventIds.has(event.id)) {
              continue;
            }
            this.seenEventIds.add(event.id);
          }
          const out = this.handleEvent(event);
          if (out.assistantText) {
            lastAssistantText = out.assistantText;
          }
          if (out.terminal) {
            saw_terminal = true;
            isError = out.isError;
            break;
          }
        }
      } catch (err) {
        if (
          this.aborted ||
          this.abortController.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        ) {
          // Cancellation path — the abort controller fired and we crashed
          // out of the for-await. Emit the cancelled `result` and return.
          const cost = this.snapshotCost(true);
          this.emit({
            type: "result",
            cost,
            isError: true,
            errorCategory: "cancelled",
          });
          this.settle({
            exitCode: 130,
            sessionId: this._sessionId,
            cost,
            isError: true,
            failureReason: "cancelled",
          });
          return;
        }
        throw err;
      }

      // 5. Stream-broken-without-terminal path: surface as an error so the
      //    runner knows the run wasn't a clean idle-completion.
      if (!saw_terminal) {
        const cost = this.snapshotCost(true);
        this.emit({
          type: "error",
          message: "Managed-agents SSE stream ended without a terminal status event.",
          category: "stream_ended",
        });
        this.emit({
          type: "result",
          cost,
          isError: true,
          errorCategory: "stream_ended",
        });
        this.settle({
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          failureReason: "stream_ended",
        });
        return;
      }

      // 6. Clean terminal. Emit `result` and settle.
      const cost = this.snapshotCost(isError);
      this.emit({
        type: "result",
        cost,
        isError,
        errorCategory: isError ? "terminated" : undefined,
        output: lastAssistantText,
      });
      this.settle({
        exitCode: isError ? 1 : 0,
        sessionId: this._sessionId,
        cost,
        isError,
        output: lastAssistantText,
        failureReason: isError ? "terminated" : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({ type: "raw_stderr", content: `[claude-managed] Error: ${message}\n` });
      this.emit({ type: "error", message });
      const cost = this.snapshotCost(true);
      this.emit({ type: "result", cost, isError: true, errorCategory: "exception" });
      this.settle({
        exitCode: 1,
        sessionId: this._sessionId,
        cost,
        isError: true,
        failureReason: message,
      });
    } finally {
      try {
        await this.logFileHandle.end();
      } catch {
        // Ignore log writer cleanup failures.
      }
    }
  }
}

export class ClaudeManagedAdapter implements ProviderAdapter {
  readonly name = "claude-managed";
  // Anthropic's cloud sandbox calls back into our /mcp endpoint, but the worker
  // process is a thin SSE relay — no /workspace, no PM2, no agent-fs, no skills FS.
  readonly traits = { hasMcp: true, hasLocalEnvironment: false };

  /** Anthropic API key (kept private; never logged). */
  private readonly apiKey: string;
  /** Managed agent identifier (created by `claude-managed-setup` CLI in Phase 2). */
  private readonly agentId: string;
  /** Managed environment identifier (created by `claude-managed-setup` CLI in Phase 2). */
  private readonly environmentId: string;
  /**
   * Anthropic SDK client. Lazily constructed in the ctor unless a test
   * supplies an injected fake — see the `client` constructor option.
   */
  private readonly client: ManagedAgentsClient;

  constructor(opts: { client?: ManagedAgentsClient } = {}) {
    const missing = REQUIRED_ENV_VARS.filter((key) => !process.env[key]);
    if (missing.length > 0) {
      throw new Error(
        `[claude-managed] Missing required env var(s): ${missing.join(", ")}. ` +
          `Run \`bun run src/cli.tsx claude-managed-setup\` to create an Anthropic-side ` +
          `agent + environment and persist their IDs to swarm_config.`,
      );
    }

    this.apiKey = process.env.ANTHROPIC_API_KEY as string;
    this.agentId = process.env.MANAGED_AGENT_ID as string;
    this.environmentId = process.env.MANAGED_ENVIRONMENT_ID as string;

    if (opts.client) {
      this.client = opts.client;
    } else {
      // Cast at the boundary — the SDK's `client.beta` surface conforms to
      // our narrower `ManagedAgentsClient` interface (which exists for
      // testability) but TypeScript can't infer that without us spelling out
      // every method signature on both sides.
      this.client = new Anthropic({ apiKey: this.apiKey }) as unknown as ManagedAgentsClient;
    }
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    let sessionId: string;
    let userMessageContent: BetaManagedAgentsTextBlock[] | null;
    const seenEventIds = new Set<string>();

    if (config.resumeSessionId) {
      // Resume path: skip `sessions.create`. Pre-fetch event history via
      // `events.list` so the SSE loop can skip duplicates that the live
      // stream replays. NO new `user.message` is sent (the agent already
      // has one in flight).
      sessionId = config.resumeSessionId;
      userMessageContent = null;
      try {
        const list = await Promise.resolve(this.client.beta.sessions.events.list(sessionId));
        for await (const evt of list) {
          if ("id" in evt && evt.id) {
            seenEventIds.add(evt.id);
          }
        }
      } catch {
        // If history fetch fails, fall through with an empty `seenEventIds`
        // — the worst case is that the listener sees a few duplicate events
        // (which the runner-side dedup handles).
      }
    } else {
      // Fresh session. Compose the cache-control-annotated user message and
      // open the managed session against the pre-existing agent + env.
      userMessageContent = composeManagedUserMessage(config);
      // Phase 4: derive `resources` from `config.vcsRepo` (which the runner
      // copies from `task.vcsRepo` at the spawn site, see
      // src/commands/runner.ts:3296). The SDK contract is
      // `BetaManagedAgentsGitHubRepositoryResourceParams`:
      //   { type: 'github_repository', url, authorization_token, checkout?: { type: 'branch', name } }
      // We default `branch` to "main" since `ProviderSessionConfig` only
      // carries the repo identifier as a string.
      //
      // GitHub auth: prefer the operator-side `MANAGED_GITHUB_VAULT_ID`
      // (passed via `vault_ids` on the session — see runbook §"Claude Managed
      // Agents — GitHub access"). If a literal PAT is supplied via
      // `MANAGED_GITHUB_TOKEN`, use that instead. Without either, the SDK's
      // required `authorization_token` field gets an empty string and the
      // operator sees an authentication error from Anthropic — which is
      // strictly better than silently dropping `resources`.
      const createParams: Record<string, unknown> = {
        agent: this.agentId,
        environment_id: this.environmentId,
        title: `Task ${config.taskId}`,
        metadata: {
          swarmAgentId: config.agentId,
          swarmTaskId: config.taskId,
        },
      };
      if (config.vcsRepo) {
        const repoUrl = normalizeRepoUrl(config.vcsRepo);
        const branch = "main"; // ProviderSessionConfig doesn't carry per-task branch info today.
        const githubToken = process.env.MANAGED_GITHUB_TOKEN ?? "";
        createParams.resources = [
          {
            type: "github_repository",
            url: repoUrl,
            authorization_token: githubToken,
            checkout: { type: "branch", name: branch },
          },
        ];
      }
      // Multiple vaults can be linked to a single session — `vault_ids` is an
      // array. The MCP vault holds the static-bearer credential for our
      // `/mcp` endpoint (provisioned by `claude-managed-setup`); the GitHub
      // vault holds the credential used by the `github_repository` resource.
      // Either or both may be unset.
      const vaultIds = [
        process.env.MANAGED_MCP_VAULT_ID,
        process.env.MANAGED_GITHUB_VAULT_ID,
      ].filter((v): v is string => !!v && v.length > 0);
      if (vaultIds.length > 0) {
        createParams.vault_ids = Array.from(new Set(vaultIds));
      }
      const created = await Promise.resolve(this.client.beta.sessions.create(createParams));
      sessionId = created.id;
    }

    return new ClaudeManagedSession(
      this.client,
      sessionId,
      config,
      userMessageContent,
      seenEventIds,
    );
  }

  /**
   * Resume eligibility: the managed session must exist and not be in a
   * terminal state. The SDK's `Session.status` enum is
   * `'rescheduling' | 'running' | 'idle' | 'terminated'`. Archived sessions
   * (`archived_at !== null`) are also rejected — we'd be reattaching to a
   * frozen session.
   */
  async canResume(sessionId: string): Promise<boolean> {
    try {
      const s = await Promise.resolve(this.client.beta.sessions.retrieve(sessionId));
      if (s.status === "terminated") return false;
      if (s.archived_at != null) return false;
      return true;
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
