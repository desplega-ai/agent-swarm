/**
 * Devin provider adapter.
 *
 * Wraps the Devin v3 REST API to implement the `ProviderAdapter` /
 * `ProviderSession` contract. Unlike Claude and Codex, Devin sessions are
 * fully remote — there is no local child process. We poll the session status
 * endpoint to drive the event stream and detect terminal states.
 *
 * Phase 1 — factory wiring, polling loop, status-to-event mapping, cost
 * tracking, playbook resolution, approval flow, structured output & PR
 * tracking.
 */

import {
  createSession,
  type DevinSessionResponse,
  type DevinSessionStatus,
  type DevinStatusDetail,
  getSession,
  getSessionMessages,
  sendMessage,
} from "./devin-api";
import { getOrCreatePlaybook } from "./devin-playbooks";
import { resolveDevinPrompt } from "./devin-skill-resolver";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** USD cost per ACU — configurable via env var. */
const DEFAULT_ACU_COST_USD = 2.25;

/** Give up after this many consecutive poll failures. */
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

/** Max time to wait for a human approval response before giving up. */
const APPROVAL_TIMEOUT_MS = 60 * 60 * 1_000; // 1 hour

/**
 * Structured output schema sent with every Devin session.
 *
 * Devin treats this as a "notepad" it fills as it works. The `status` field
 * lets us detect completion even when Devin stays in `waiting_for_user`
 * instead of transitioning to `finished`. The adapter checks for
 * `status === "done"` in the `waiting_for_user` handler.
 */
const DEVIN_STRUCTURED_OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    status: {
      type: "string",
      enum: ["working", "done", "needs_input", "error"],
      description:
        "Set to 'done' when the task is fully complete, 'needs_input' when you need clarification, 'error' if the task cannot be completed.",
    },
    output: {
      type: "string",
      description: "The final output or result of the task.",
    },
    summary: {
      type: "string",
      description: "A brief summary of what was accomplished.",
    },
  },
  required: ["status"],
} as const;

// ---------------------------------------------------------------------------
// DevinSession
// ---------------------------------------------------------------------------

class DevinSession implements ProviderSession {
  private readonly config: ProviderSessionConfig;
  private readonly orgId: string;
  private readonly devinApiKey: string;
  private readonly pollIntervalMs: number;
  private readonly acuCostUsd: number;
  private readonly maxAcuLimit: number | undefined;

  private readonly listeners: Array<(event: ProviderEvent) => void> = [];
  private readonly eventQueue: ProviderEvent[] = [];
  private readonly logFileHandle: ReturnType<ReturnType<typeof Bun.file>["writer"]>;
  private readonly startTime = Date.now();
  private readonly completionPromise: Promise<ProviderResult>;
  private resolveCompletion!: (result: ProviderResult) => void;

  private _sessionId: string | undefined;
  private sessionUrl: string | undefined;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private pollCount = 0;
  private aborted = false;
  private settled = false;

  // State tracking for change detection across polls.
  private lastStatus: DevinSessionStatus | undefined;
  private lastStatusDetail: DevinStatusDetail | undefined;
  private lastStructuredOutput: string | undefined;
  private seenPrUrls = new Set<string>();
  private seenMessageIds = new Set<string>();
  private approvalRequested = false;
  private consecutivePollErrors = 0;
  private humanResponseTimer: ReturnType<typeof setInterval> | null = null;
  private messageCursor: string | undefined;

  constructor(
    config: ProviderSessionConfig,
    orgId: string,
    devinApiKey: string,
    sessionResponse: DevinSessionResponse,
    maxAcuLimit?: number,
  ) {
    this.config = config;
    this.orgId = orgId;
    this.devinApiKey = devinApiKey;
    this.pollIntervalMs = Number(process.env.DEVIN_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
    this.acuCostUsd = Number(process.env.DEVIN_ACU_COST_USD) || DEFAULT_ACU_COST_USD;
    this.maxAcuLimit = maxAcuLimit;

    this._sessionId = sessionResponse.session_id;
    this.sessionUrl = sessionResponse.url;
    this.logFileHandle = Bun.file(config.logFile).writer();

    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

    // Emit initial session_init event.
    this.emit({
      type: "session_init",
      sessionId: sessionResponse.session_id,
      provider: "devin",
      providerMeta: {
        sessionUrl: sessionResponse.url,
        ...(this.maxAcuLimit != null ? { maxAcuLimit: this.maxAcuLimit } : {}),
        acuCostUsd: this.acuCostUsd,
      },
    });
    this.emit({
      type: "message",
      role: "assistant",
      content: `Devin session created: ${sessionResponse.url}`,
    });

    // Record initial state.
    this.lastStatus = sessionResponse.status;
    this.lastStatusDetail = sessionResponse.status_detail;

    // Start the polling loop.
    this.startPolling();
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    // Flush queued events to the new listener.
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue.length = 0;
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    this.aborted = true;
    this.stopPolling();
    // Deliberately do NOT archive the Devin session here. The session remains
    // alive in Cognition's cloud so `canResume()` can return true and the
    // runner can retry later via `sendMessage()`. Archiving is a hard kill
    // with no undo — only do that via an explicit API call if needed.
    if (!this.settled) {
      const cost = this.buildCostData(0, true);
      this.emit({ type: "result", cost, isError: true, errorCategory: "cancelled" });
      this.settle({
        exitCode: 130,
        sessionId: this._sessionId,
        cost,
        isError: true,
        failureReason: "cancelled",
      });
    }
  }

  // -------------------------------------------------------------------------
  // Event infrastructure (mirrors codex-adapter)
  // -------------------------------------------------------------------------

  private emit(event: ProviderEvent): void {
    try {
      this.logFileHandle.write(
        `${JSON.stringify({ ...event, timestamp: new Date().toISOString() })}\n`,
      );
    } catch {
      // Log writer failure must not break the event stream.
    }
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        try {
          listener(event);
        } catch {
          // Swallow listener errors.
        }
      }
    } else {
      this.eventQueue.push(event);
    }
  }

  private settle(result: ProviderResult): void {
    if (this.settled) return;
    this.settled = true;
    this.stopPolling();
    try {
      const flushed = this.logFileHandle.flush();
      (flushed instanceof Promise ? flushed : Promise.resolve(flushed))
        .then(() => this.logFileHandle.end())
        .catch(() => {});
    } catch {
      // Ignore log writer cleanup failures.
    }
    this.resolveCompletion(result);
  }

  // -------------------------------------------------------------------------
  // Polling loop
  // -------------------------------------------------------------------------

  private startPolling(): void {
    // Do an immediate first poll, then set up the interval.
    void this.poll();
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, this.pollIntervalMs);
  }

  private stopPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.humanResponseTimer) {
      clearInterval(this.humanResponseTimer);
      this.humanResponseTimer = null;
    }
  }

  private async poll(): Promise<void> {
    if (this.settled || this.aborted) return;
    this.pollCount += 1;

    let response: DevinSessionResponse;
    try {
      response = await getSession(this.orgId, this.devinApiKey, this._sessionId!);
    } catch (err) {
      this.consecutivePollErrors += 1;
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "raw_stderr",
        content: `[devin] Poll error (${this.consecutivePollErrors}/${MAX_CONSECUTIVE_POLL_ERRORS}): ${message}\n`,
      });
      if (this.consecutivePollErrors >= MAX_CONSECUTIVE_POLL_ERRORS) {
        const reason = `Devin polling abandoned after ${MAX_CONSECUTIVE_POLL_ERRORS} consecutive errors. Last: ${message}`;
        this.emit({ type: "error", message: reason });
        const cost = this.buildCostData(0, true);
        this.emit({ type: "result", cost, isError: true, errorCategory: "poll_failure" });
        this.settle({
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          failureReason: reason,
        });
      }
      return;
    }
    // Reset on successful poll.
    this.consecutivePollErrors = 0;

    // Log raw poll data to local JSONL file for debugging, but don't emit
    // as raw_log — the session log viewer can't parse the Devin API shape
    // and silently drops it. Conversation messages are emitted separately
    // in pollMessages() in a format the viewer understands.
    try {
      this.logFileHandle.write(
        `${JSON.stringify({ type: "raw_log", content: JSON.stringify(response), timestamp: new Date().toISOString() })}\n`,
      );
    } catch {
      // Log writer failure must not break the event stream.
    }

    // Track structured output changes.
    const currentStructuredOutput = response.structured_output
      ? JSON.stringify(response.structured_output)
      : undefined;
    if (currentStructuredOutput && currentStructuredOutput !== this.lastStructuredOutput) {
      this.lastStructuredOutput = currentStructuredOutput;
      this.emit({
        type: "custom",
        name: "devin.structured_output",
        data: { sessionId: this._sessionId, structuredOutput: response.structured_output },
      });
      const so = response.structured_output as Record<string, unknown>;
      this.emitSystemLog("structured_output", {
        taskStatus: so.status,
        output: so.output,
        summary: so.summary,
      });
    }

    // Track new pull requests.
    if (response.pull_requests) {
      for (const pr of response.pull_requests) {
        if (!this.seenPrUrls.has(pr.pr_url)) {
          this.seenPrUrls.add(pr.pr_url);
          this.emit({
            type: "custom",
            name: "devin.pull_request",
            data: { sessionId: this._sessionId, prUrl: pr.pr_url, prState: pr.pr_state },
          });
        }
      }
    }

    // Fetch new conversation messages from Devin.
    await this.pollMessages();

    // Process status transitions.
    const statusChanged =
      response.status !== this.lastStatus || response.status_detail !== this.lastStatusDetail;
    this.lastStatus = response.status;
    this.lastStatusDetail = response.status_detail;

    this.processStatus(response, statusChanged);
  }

  // -------------------------------------------------------------------------
  // Conversation messages
  // -------------------------------------------------------------------------

  private async pollMessages(): Promise<void> {
    try {
      const resp = await getSessionMessages(
        this.orgId,
        this.devinApiKey,
        this._sessionId!,
        this.messageCursor,
      );
      if (resp.end_cursor) {
        this.messageCursor = resp.end_cursor;
      }
      for (const msg of resp.items) {
        if (this.seenMessageIds.has(msg.event_id)) continue;
        this.seenMessageIds.add(msg.event_id);
        const role = msg.source === "devin" ? "assistant" : "user";
        this.emit({
          type: "raw_log",
          content: JSON.stringify({
            type: role,
            message: { role, content: msg.message },
          }),
        });
        this.emit({ type: "message", role, content: msg.message });
      }
    } catch {
      // Non-fatal — messages are supplementary to status polling.
    }
  }

  // -------------------------------------------------------------------------
  // Status-to-event mapping
  // -------------------------------------------------------------------------

  private processStatus(response: DevinSessionResponse, statusChanged: boolean): void {
    const { status } = response;

    switch (status) {
      case "new":
      case "creating":
      case "claimed":
      case "resuming": {
        if (statusChanged) {
          this.emit({ type: "progress", message: status });
          this.emitSystemLog("status", { status, statusDetail: status });
        }
        break;
      }

      case "running": {
        this.processRunningStatus(response, statusChanged);
        break;
      }

      case "exit": {
        this.handleTerminalSuccess(response);
        break;
      }

      case "error": {
        this.handleTerminalError(response);
        break;
      }

      case "suspended": {
        this.handleSuspended(response);
        break;
      }
    }
  }

  private processRunningStatus(response: DevinSessionResponse, statusChanged: boolean): void {
    const detail = response.status_detail;

    // Check structured output completion before examining status_detail.
    // Devin may set structured output `status: "done"` while still in any
    // running sub-state (working, waiting_for_user, etc.) — the structured
    // output is the authoritative completion signal.
    if (this.isStructuredOutputDone(response)) {
      this.handleTerminalSuccess(response);
      return;
    }

    switch (detail) {
      case "working": {
        if (statusChanged) {
          this.emit({ type: "progress", message: "working" });
          this.emitSystemLog("status", { status: "running", statusDetail: "working" });
        }
        break;
      }

      case "waiting_for_user": {
        if (statusChanged) {
          this.emit({ type: "progress", message: "waiting for user" });
          this.emitSystemLog("status", {
            status: "running",
            statusDetail: "waiting_for_user",
          });
          this.emit({
            type: "message",
            role: "assistant",
            content: `Devin is waiting for user input. Session: ${this.sessionUrl}`,
          });
        }
        break;
      }

      case "waiting_for_approval": {
        if (statusChanged) {
          this.emit({ type: "progress", message: "waiting for approval" });
          this.emitSystemLog("status", {
            status: "running",
            statusDetail: "waiting_for_approval",
          });
        }
        // Request human input via the swarm API (once per approval cycle).
        if (!this.approvalRequested) {
          this.approvalRequested = true;
          void this.requestHumanApproval();
        }
        break;
      }

      case "finished": {
        this.handleTerminalSuccess(response);
        break;
      }

      default: {
        if (statusChanged) {
          const label = detail ?? "unknown";
          this.emit({ type: "progress", message: label });
          this.emitSystemLog("status", { status: "running", statusDetail: label });
        }
        break;
      }
    }
  }

  private handleTerminalSuccess(response: DevinSessionResponse): void {
    const acusConsumed = response.acus_consumed ?? 0;
    const output = this.formatStructuredOutput();
    const cost = this.buildCostData(acusConsumed, false);

    this.emit({ type: "progress", message: "completed" });
    this.emitSystemLog("status", {
      status: "completed",
      acusConsumed,
      sessionUrl: this.sessionUrl,
    });
    this.emit({
      type: "message",
      role: "assistant",
      content: `Devin session completed successfully. ACUs consumed: ${acusConsumed}. Session: ${this.sessionUrl}`,
    });
    this.emit({ type: "result", cost, output, isError: false });
    this.settle({
      exitCode: 0,
      sessionId: this._sessionId,
      cost,
      output,
      isError: false,
    });
  }

  private handleTerminalError(response: DevinSessionResponse): void {
    const acusConsumed = response.acus_consumed ?? 0;
    const cost = this.buildCostData(acusConsumed, true);
    const message = `Devin session ended with error. ACUs consumed: ${acusConsumed}. Session: ${this.sessionUrl}`;

    this.emitSystemLog("status", {
      status: "error",
      acusConsumed,
      sessionUrl: this.sessionUrl,
    });
    this.emit({ type: "error", message });
    this.emit({ type: "result", cost, isError: true, errorCategory: "devin_error" });
    this.settle({
      exitCode: 1,
      sessionId: this._sessionId,
      cost,
      isError: true,
      failureReason: message,
    });
  }

  private handleSuspended(response: DevinSessionResponse): void {
    const acusConsumed = response.acus_consumed ?? 0;
    const detail = response.status_detail;
    const cost = this.buildCostData(acusConsumed, true);

    const categoryMap: Record<string, string> = {
      inactivity: "suspended_inactivity",
      user_request: "suspended_user",
      usage_limit_exceeded: "suspended_cost",
      out_of_credits: "suspended_cost",
      out_of_quota: "suspended_cost",
      no_quota_allocation: "suspended_cost",
      payment_declined: "suspended_cost",
      org_usage_limit_exceeded: "suspended_cost",
      error: "suspended_cost",
    };

    const errorCategory = categoryMap[detail ?? ""] ?? "suspended";
    const reason = `Devin session suspended${detail ? `: ${detail.replaceAll("_", " ")}` : ""}`;

    if (detail === "inactivity") {
      this.emit({
        type: "message",
        role: "assistant",
        content: `Devin session suspended due to inactivity. Session: ${this.sessionUrl}`,
      });
    }

    if (errorCategory === "suspended_cost" || errorCategory === "suspended") {
      this.emit({ type: "error", message: reason });
    }

    this.emit({ type: "result", cost, isError: true, errorCategory });
    this.settle({
      exitCode: 1,
      sessionId: this._sessionId,
      cost,
      isError: true,
      errorCategory,
      failureReason: reason,
    });
  }

  // -------------------------------------------------------------------------
  // Approval flow
  // -------------------------------------------------------------------------

  private async requestHumanApproval(): Promise<void> {
    if (!this.config.apiUrl || !this.config.apiKey || !this.config.taskId) return;

    // Why a direct API call instead of an emit? The runner's event listener
    // handles ProviderEvents generically (progress, cost) but has no built-in
    // handler that creates human-input requests from events. Claude/Codex
    // trigger this via their MCP tool (`request-human-input`), which calls
    // the same API endpoint under the hood. Since Devin has no MCP, we call
    // the API directly — it's what stores the request in the DB and triggers
    // Slack routing.
    try {
      const res = await fetch(`${this.config.apiUrl}/api/tasks/${this.config.taskId}/human-input`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.config.apiKey}`,
          "Content-Type": "application/json",
          "X-Agent-ID": this.config.agentId,
        },
        body: JSON.stringify({
          question: `Devin is waiting for approval. Please review and respond. Session: ${this.sessionUrl}`,
        }),
      });
      if (!res.ok) {
        this.emit({
          type: "raw_stderr",
          content: `[devin] Failed to request human approval: HTTP ${res.status}\n`,
        });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.emit({
        type: "raw_stderr",
        content: `[devin] Failed to request human approval: ${message}\n`,
      });
    }

    // Poll for the human response and relay it to Devin.
    void this.pollForHumanResponse();
  }

  private async pollForHumanResponse(): Promise<void> {
    if (!this.config.apiUrl || !this.config.apiKey || !this.config.taskId) return;

    // Clear any previous human-response timer before starting a new one.
    if (this.humanResponseTimer) clearInterval(this.humanResponseTimer);

    const approvalStart = Date.now();

    // Simple polling loop — check every poll interval for a human response.
    this.humanResponseTimer = setInterval(async () => {
      if (this.settled || this.aborted) {
        if (this.humanResponseTimer) {
          clearInterval(this.humanResponseTimer);
          this.humanResponseTimer = null;
        }
        return;
      }

      // Give up after APPROVAL_TIMEOUT_MS to avoid leaking timers on
      // abandoned approval flows. Devin's own inactivity timeout will
      // eventually suspend the session, which the main poll loop handles.
      if (Date.now() - approvalStart > APPROVAL_TIMEOUT_MS) {
        this.emit({
          type: "raw_stderr",
          content: `[devin] Approval polling timed out after ${APPROVAL_TIMEOUT_MS / 60_000} minutes\n`,
        });
        if (this.humanResponseTimer) {
          clearInterval(this.humanResponseTimer);
          this.humanResponseTimer = null;
        }
        return;
      }

      try {
        const res = await fetch(
          `${this.config.apiUrl}/api/tasks/${this.config.taskId}/human-input`,
          {
            method: "GET",
            headers: {
              Authorization: `Bearer ${this.config.apiKey}`,
              "X-Agent-ID": this.config.agentId,
            },
          },
        );
        if (res.ok) {
          const data = (await res.json()) as { response?: string; answered?: boolean };
          if (data.answered && data.response) {
            if (this.humanResponseTimer) {
              clearInterval(this.humanResponseTimer);
              this.humanResponseTimer = null;
            }
            this.approvalRequested = false;
            // Relay the human response to Devin.
            try {
              await sendMessage(this.orgId, this.devinApiKey, this._sessionId!, data.response);
              this.emit({
                type: "message",
                role: "user",
                content: `Human response relayed to Devin: ${data.response}`,
              });
            } catch (err) {
              const message = err instanceof Error ? err.message : String(err);
              this.emit({
                type: "raw_stderr",
                content: `[devin] Failed to relay human response: ${message}\n`,
              });
            }
          }
        }
      } catch {
        // Transient failure — keep trying.
      }
    }, this.pollIntervalMs);
  }

  // -------------------------------------------------------------------------
  // Structured output completion detection
  // -------------------------------------------------------------------------

  /**
   * Check if the structured output signals task completion.
   * Returns true when the structured output has `status: "done"`.
   */
  private isStructuredOutputDone(response: DevinSessionResponse): boolean {
    const output = response.structured_output;
    if (!output || typeof output !== "object") return false;
    return (output as Record<string, unknown>).status === "done";
  }

  /**
   * Extract human-readable text from the last structured output.
   * Returns summary + output joined as plain text, or the raw JSON
   * string if extraction fails.
   */
  private formatStructuredOutput(): string | undefined {
    if (!this.lastStructuredOutput) return undefined;
    try {
      const parsed = JSON.parse(this.lastStructuredOutput);
      if (typeof parsed === "object" && parsed !== null) {
        const parts: string[] = [];
        if (parsed.summary) parts.push(parsed.summary);
        if (parsed.output) parts.push(parsed.output);
        if (parts.length > 0) return parts.join("\n\n");
      }
    } catch {
      // Fall through to raw.
    }
    return this.lastStructuredOutput;
  }

  // -------------------------------------------------------------------------
  // Session log helpers
  // -------------------------------------------------------------------------

  /**
   * Emit a system-role raw_log entry that the session log viewer can parse.
   * Used for status transitions and structured output — these render as
   * system messages with a `provider_meta` payload so the viewer can add
   * pills/colors.
   */
  private emitSystemLog(kind: "status" | "structured_output", data: Record<string, unknown>): void {
    this.emit({
      type: "raw_log",
      content: JSON.stringify({
        type: "system",
        message: { role: "system", content: "" },
        provider_meta: { provider: "devin", kind, ...data },
      }),
    });
  }

  // -------------------------------------------------------------------------
  // Cost tracking
  // -------------------------------------------------------------------------

  private buildCostData(acusConsumed: number, isError: boolean): CostData {
    return {
      sessionId: this._sessionId ?? "",
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: acusConsumed * this.acuCostUsd,
      inputTokens: 0,
      outputTokens: 0,
      durationMs: Date.now() - this.startTime,
      numTurns: this.pollCount,
      model: "devin",
      isError,
    };
  }
}

// ---------------------------------------------------------------------------
// DevinAdapter
// ---------------------------------------------------------------------------

export class DevinAdapter implements ProviderAdapter {
  readonly name = "devin";
  /** Cached from the most recent createSession() for canResume() fallback. */
  private lastApiKey?: string;
  private lastOrgId?: string;
  get traits(): ProviderTraits {
    const hasMcp = (process.env.HAS_MCP ?? "").toLowerCase() === "true";
    return { hasMcp, hasLocalEnvironment: false };
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Resolve credentials from config.env (injected by runner) or process.env.
    const env = config.env ?? {};
    const devinApiKey = env.DEVIN_API_KEY ?? process.env.DEVIN_API_KEY;
    const orgId = env.DEVIN_ORG_ID ?? process.env.DEVIN_ORG_ID;

    if (!devinApiKey) {
      throw new Error("[devin] DEVIN_API_KEY is required. Set it in environment or agent config.");
    }
    if (!orgId) {
      throw new Error("[devin] DEVIN_ORG_ID is required. Set it in environment or agent config.");
    }

    // Cache for canResume() which only receives a sessionId.
    this.lastApiKey = devinApiKey;
    this.lastOrgId = orgId;

    const hasMcp = (env.HAS_MCP ?? process.env.HAS_MCP ?? "").toLowerCase() === "true";
    if (hasMcp) {
      throw new Error(
        "[devin] HAS_MCP=true is not supported yet — Devin MCP integration has not been tested.",
      );
    }

    // NOTE: is there a better place to handle this logic?
    if (config.role === "lead" && !hasMcp) {
      // Probably cannot happen as the envs from devin and the lead live in different files, but jsut in case
      throw new Error(
        "[devin] Devin is configured as lead but HAS_MCP=false. A lead needs access to the MCP to function. ",
      );
    }

    // If there's a system prompt, resolve it to a playbook.
    let playbookId: string | undefined;
    if (config.systemPrompt) {
      try {
        playbookId = await getOrCreatePlaybook(
          orgId,
          devinApiKey,
          `swarm-${config.taskId ?? "session"}`,
          // systemPrompt is per-agent (not per-task). The runner composes it
          // from the agent's template + role config. It's stable across tasks
          // for the same agent, so the playbook cache effectively deduplicates
          // — one playbook per agent configuration, reused across tasks.
          config.systemPrompt,
          config.apiUrl,
          config.apiKey,
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Non-fatal — log and continue without playbook.
        console.error(`[devin] Failed to create playbook: ${message}`);
      }
    }

    // Build repos array from the task's vcsRepo (e.g. "owner/repo").
    const repos: string[] = [];
    if (config.vcsRepo) {
      repos.push(config.vcsRepo);
    }
    // Inline skill content if prompt starts with @skills:<name>.
    const resolvedPrompt = await resolveDevinPrompt(config.prompt);

    // Resolve max ACU limit from env.
    const rawAcuLimit = env.DEVIN_MAX_ACU_LIMIT ?? process.env.DEVIN_MAX_ACU_LIMIT;
    const maxAcuLimit = rawAcuLimit ? Number(rawAcuLimit) : undefined;

    // Create the Devin session.
    const sessionResponse = await createSession(orgId, devinApiKey, {
      prompt: resolvedPrompt,
      ...(playbookId ? { playbook_id: playbookId } : {}),
      ...(repos.length > 0 ? { repos } : {}),
      ...(maxAcuLimit != null ? { max_acu_limit: maxAcuLimit } : {}),
      structured_output_schema: DEVIN_STRUCTURED_OUTPUT_SCHEMA,
      title: `swarm-task-${config.taskId ?? "unknown"}`,
      tags: ["agent-swarm", config.agentId],
    });

    return new DevinSession(config, orgId, devinApiKey, sessionResponse, maxAcuLimit);
  }

  async canResume(sessionId: string): Promise<boolean> {
    if (!sessionId || typeof sessionId !== "string") return false;

    const devinApiKey = this.lastApiKey ?? process.env.DEVIN_API_KEY;
    const orgId = this.lastOrgId ?? process.env.DEVIN_ORG_ID;
    if (!devinApiKey || !orgId) return false;

    try {
      const response = await getSession(orgId, devinApiKey, sessionId);
      // Devin's API may allow sending messages to some errored sessions, but
      // not all error subtypes are recoverable. Conservative default: treat
      // `error` as non-resumable to avoid the runner looping on a broken session.
      // Only `suspended` sessions (inactivity, user_request, cost limits) are resumable.
      return response.status !== "exit" && response.status !== "error";
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    return `@skills:${commandName}`;
  }
}
