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
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/** Default polling interval in milliseconds. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/** USD cost per ACU — configurable via env var. */
const DEFAULT_ACU_COST_USD = 2.25;

/** Give up after this many consecutive poll failures. */
const MAX_CONSECUTIVE_POLL_ERRORS = 10;

// ---------------------------------------------------------------------------
// DevinSession
// ---------------------------------------------------------------------------

class DevinSession implements ProviderSession {
  private readonly config: ProviderSessionConfig;
  private readonly orgId: string;
  private readonly devinApiKey: string;
  private readonly pollIntervalMs: number;
  private readonly acuCostUsd: number;

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
  private approvalRequested = false;
  private consecutivePollErrors = 0;
  private messageCursor: string | undefined;

  constructor(
    config: ProviderSessionConfig,
    orgId: string,
    devinApiKey: string,
    sessionResponse: DevinSessionResponse,
  ) {
    this.config = config;
    this.orgId = orgId;
    this.devinApiKey = devinApiKey;
    this.pollIntervalMs = Number(process.env.DEVIN_POLL_INTERVAL_MS) || DEFAULT_POLL_INTERVAL_MS;
    this.acuCostUsd = Number(process.env.DEVIN_ACU_COST_USD) || DEFAULT_ACU_COST_USD;

    this._sessionId = sessionResponse.session_id;
    this.sessionUrl = sessionResponse.url;
    this.logFileHandle = Bun.file(config.logFile).writer();

    this.completionPromise = new Promise<ProviderResult>((resolve) => {
      this.resolveCompletion = resolve;
    });

    // Emit initial session_init event.
    this.emit({ type: "session_init", sessionId: sessionResponse.session_id });
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
      this.logFileHandle.end();
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

    // Always emit raw poll data for debugging.
    this.emit({ type: "raw_log", content: JSON.stringify(response) });

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
        const role = msg.source === "devin" ? "assistant" : "user";
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
    const { status, status_detail } = response;

    switch (status) {
      case "new":
      case "creating":
      case "claimed":
      case "resuming": {
        if (statusChanged) {
          this.emit({
            type: "custom",
            name: "devin.status",
            data: { sessionId: this._sessionId, status, statusDetail: status_detail },
          });
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

    switch (detail) {
      case "working": {
        if (statusChanged) {
          this.emit({
            type: "custom",
            name: "devin.status",
            data: {
              sessionId: this._sessionId,
              status: "running",
              statusDetail: "working",
            },
          });
        }
        break;
      }

      case "waiting_for_user": {
        if (statusChanged) {
          this.emit({
            type: "custom",
            name: "devin.status",
            data: {
              sessionId: this._sessionId,
              status: "running",
              statusDetail: "waiting_for_user",
            },
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
          this.emit({
            type: "custom",
            name: "devin.approval_needed",
            data: { sessionId: this._sessionId, sessionUrl: this.sessionUrl },
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
        // Unknown running sub-status — emit as a generic status event.
        if (statusChanged) {
          this.emit({
            type: "custom",
            name: "devin.status",
            data: {
              sessionId: this._sessionId,
              status: "running",
              statusDetail: detail,
            },
          });
        }
        break;
      }
    }
  }

  private handleTerminalSuccess(response: DevinSessionResponse): void {
    const acusConsumed = response.acus_consumed ?? 0;
    const output = this.lastStructuredOutput ?? undefined;
    const cost = this.buildCostData(acusConsumed, false);

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

    switch (detail) {
      case "inactivity": {
        const cost = this.buildCostData(acusConsumed, true);
        this.emit({
          type: "message",
          role: "assistant",
          content: `Devin session suspended due to inactivity. Session: ${this.sessionUrl}`,
        });
        this.emit({
          type: "result",
          cost,
          isError: true,
          errorCategory: "suspended_inactivity",
        });
        this.settle({
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          errorCategory: "suspended_inactivity",
          failureReason: "Devin session suspended due to inactivity",
        });
        break;
      }

      case "user_request": {
        const cost = this.buildCostData(acusConsumed, true);
        this.emit({
          type: "result",
          cost,
          isError: true,
          errorCategory: "suspended_user",
        });
        this.settle({
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          errorCategory: "suspended_user",
          failureReason: "Devin session suspended by user request",
        });
        break;
      }

      case "usage_limit_exceeded":
      case "out_of_credits": {
        const cost = this.buildCostData(acusConsumed, true);
        const reason =
          detail === "usage_limit_exceeded"
            ? "Devin session suspended: usage limit exceeded"
            : "Devin session suspended: out of credits";
        this.emit({ type: "error", message: reason });
        this.emit({
          type: "result",
          cost,
          isError: true,
          errorCategory: "suspended_cost",
        });
        this.settle({
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          errorCategory: "suspended_cost",
          failureReason: reason,
        });
        break;
      }

      default: {
        // Unknown suspended reason — treat as error.
        const cost = this.buildCostData(acusConsumed, true);
        const reason = `Devin session suspended: ${detail ?? "unknown reason"}`;
        this.emit({ type: "error", message: reason });
        this.emit({ type: "result", cost, isError: true, errorCategory: "suspended" });
        this.settle({
          exitCode: 1,
          sessionId: this._sessionId,
          cost,
          isError: true,
          errorCategory: "suspended",
          failureReason: reason,
        });
        break;
      }
    }
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

    // Simple polling loop — check every poll interval for a human response.
    const checkInterval = setInterval(async () => {
      if (this.settled || this.aborted) {
        clearInterval(checkInterval);
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
            clearInterval(checkInterval);
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
        );
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        // Non-fatal — log and continue without playbook.
        console.error(`[devin] Failed to create playbook: ${message}`);
      }
    }

    // Build repos array from env.
    const repos: string[] = [];
    const devinRepos = env.DEVIN_REPOS ?? process.env.DEVIN_REPOS;
    if (devinRepos) {
      repos.push(
        ...devinRepos
          .split(",")
          .map((r) => r.trim())
          .filter(Boolean),
      );
    }
    const skillsRepo = env.DEVIN_SKILLS_REPO ?? process.env.DEVIN_SKILLS_REPO;
    if (skillsRepo) {
      repos.push(skillsRepo.trim());
    }

    // Create the Devin session.
    const sessionResponse = await createSession(orgId, devinApiKey, {
      prompt: config.prompt,
      ...(playbookId ? { playbook_id: playbookId } : {}),
      ...(repos.length > 0 ? { repos } : {}),
      title: `swarm-task-${config.taskId ?? "unknown"}`,
      tags: ["agent-swarm", config.agentId],
    });

    return new DevinSession(config, orgId, devinApiKey, sessionResponse);
  }

  async canResume(sessionId: string): Promise<boolean> {
    if (!sessionId || typeof sessionId !== "string") return false;

    const devinApiKey = process.env.DEVIN_API_KEY;
    const orgId = process.env.DEVIN_ORG_ID;
    if (!devinApiKey || !orgId) return false;

    try {
      const response = await getSession(orgId, devinApiKey, sessionId);
      return response.status !== "exit" && response.status !== "error";
    } catch {
      return false;
    }
  }

  formatCommand(commandName: string): string {
    return `@skills:${commandName}`;
  }
}
