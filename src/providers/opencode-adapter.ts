/**
 * Opencode provider adapter.
 *
 * Sub-4 added the OpencodeAdapter skeleton; this sub-5 implementation adds the
 * full session lifecycle: spawn an in-process opencode server, subscribe to the
 * SSE event stream, map events to ProviderEvent, accumulate cost, and persist
 * every event as a raw_log row.
 */

import type { AssistantMessage, Event as OpencodeEvent } from "@opencode-ai/sdk";
import { createOpencode } from "@opencode-ai/sdk";
import { validateOpencodeCredentials } from "../utils/credentials";
import { scrubSecrets } from "../utils/secret-scrubber";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

function isAssistantMessage(msg: unknown): msg is AssistantMessage {
  return (
    typeof msg === "object" &&
    msg !== null &&
    (msg as AssistantMessage).role === "assistant" &&
    typeof (msg as AssistantMessage).cost === "number"
  );
}

class OpencodeSession implements ProviderSession {
  private _sessionId: string;
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private completionResolve!: (result: ProviderResult) => void;
  private completionReject!: (err: Error) => void;
  private completionPromise: Promise<ProviderResult>;
  private server: { url: string; close(): void };
  private aborted = false;

  // Running cost accumulators
  private totalCostUsd = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private cacheReadTokens = 0;
  private cacheWriteTokens = 0;
  private numTurns = 0;
  private startedAt = Date.now();
  private model: string;
  private agentId: string;
  private taskId: string;

  constructor(
    sessionId: string,
    server: { url: string; close(): void },
    model: string,
    agentId: string,
    taskId: string,
  ) {
    this._sessionId = sessionId;
    this.server = server;
    this.model = model;
    this.agentId = agentId;
    this.taskId = taskId;
    this.completionPromise = new Promise<ProviderResult>((resolve, reject) => {
      this.completionResolve = resolve;
      this.completionReject = reject;
    });
  }

  get sessionId(): string {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
  }

  private emit(event: ProviderEvent): void {
    for (const l of this.listeners) {
      l(event);
    }
    // Also emit a raw_log for every event (scrubbed)
    if (event.type !== "raw_log") {
      const raw = scrubSecrets(JSON.stringify(event));
      this.emitDirect({ type: "raw_log", content: raw });
    }
  }

  private emitDirect(event: ProviderEvent): void {
    for (const l of this.listeners) {
      l(event);
    }
  }

  /** Process a single opencode SSE event */
  handleOpencodeEvent(ev: OpencodeEvent): void {
    if (this.aborted) return;

    // Always emit the raw event as a scrubbed raw_log
    const rawContent = scrubSecrets(JSON.stringify(ev));
    this.emitDirect({ type: "raw_log", content: rawContent });

    switch (ev.type) {
      case "message.updated": {
        const msg = ev.properties.info;
        if (!isAssistantMessage(msg) || msg.sessionID !== this._sessionId) break;
        // Accumulate cost from each completed assistant message ("step")
        this.totalCostUsd += msg.cost;
        this.inputTokens += msg.tokens?.input ?? 0;
        this.outputTokens += msg.tokens?.output ?? 0;
        this.cacheReadTokens += msg.tokens?.cache?.read ?? 0;
        this.cacheWriteTokens += msg.tokens?.cache?.write ?? 0;
        this.numTurns += 1;
        if (!this.model && msg.modelID) this.model = msg.modelID;
        break;
      }

      case "session.idle": {
        if (ev.properties.sessionID !== this._sessionId) break;
        const cost = this.buildCostData(false);
        const resultEvent: ProviderEvent = {
          type: "result",
          cost,
          isError: false,
        };
        // Emit result (raw_log will be auto-emitted via emit())
        for (const l of this.listeners) l(resultEvent);
        const raw = scrubSecrets(JSON.stringify(resultEvent));
        this.emitDirect({ type: "raw_log", content: raw });
        this.completionResolve({
          exitCode: 0,
          sessionId: this._sessionId,
          cost,
          isError: false,
        });
        break;
      }

      case "session.error": {
        if (ev.properties.sessionID !== undefined && ev.properties.sessionID !== this._sessionId)
          break;
        const errMsg =
          ev.properties.error && "message" in ev.properties.error
            ? String((ev.properties.error as { message?: string }).message ?? "unknown error")
            : "opencode session error";
        this.emitError(errMsg);
        break;
      }

      case "permission.updated": {
        if (ev.properties.sessionID !== this._sessionId) break;
        // Headless worker cannot interactively approve permissions — treat as error
        this.emitError(
          `Permission request received in headless mode (id=${ev.properties.id}); aborting session`,
        );
        break;
      }

      default:
        break;
    }
  }

  private emitError(message: string): void {
    const errorEvent: ProviderEvent = { type: "error", message };
    for (const l of this.listeners) l(errorEvent);
    const raw = scrubSecrets(JSON.stringify(errorEvent));
    this.emitDirect({ type: "raw_log", content: raw });
    const cost = this.buildCostData(true);
    this.completionResolve({
      exitCode: 1,
      sessionId: this._sessionId,
      cost,
      isError: true,
      failureReason: message,
    });
  }

  private buildCostData(isError: boolean): CostData {
    return {
      sessionId: this._sessionId,
      taskId: this.taskId,
      agentId: this.agentId,
      totalCostUsd: this.totalCostUsd,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      cacheReadTokens: this.cacheReadTokens,
      cacheWriteTokens: this.cacheWriteTokens,
      durationMs: Date.now() - this.startedAt,
      numTurns: this.numTurns,
      model: this.model,
      isError,
      provider: "opencode",
    };
  }

  async waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.server.close();
    this.completionResolve({
      exitCode: 1,
      sessionId: this._sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }
}

export class OpencodeAdapter implements ProviderAdapter {
  readonly name = "opencode";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasLocalEnvironment: true,
  };

  validateCredentials(env: Record<string, string | undefined> = {}): string {
    return validateOpencodeCredentials(env);
  }

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    // Spin up an in-process opencode server + client
    const { client, server } = await createOpencode({ hostname: "127.0.0.1", port: 0 });

    // Create the opencode session (project directory = config.cwd)
    const createResult = await client.session.create({ query: { directory: config.cwd } });
    if (!createResult.data) {
      server.close();
      throw new Error("Failed to create opencode session");
    }
    const opencodeSession = createResult.data;
    const sessionId = opencodeSession.id;

    const session = new OpencodeSession(
      sessionId,
      server,
      config.model,
      config.agentId,
      config.taskId,
    );

    // Emit session_init immediately
    session.onEvent; // ensure listeners are set up before emitting
    // Listeners are attached externally after createSession returns, so we
    // queue the init event to emit after the current microtask queue drains.
    Promise.resolve().then(() => {
      for (const l of (session as unknown as { listeners: Array<(e: ProviderEvent) => void> })
        .listeners) {
        l({ type: "session_init", sessionId, provider: "opencode" });
      }
      const raw = scrubSecrets(JSON.stringify({ type: "session_init", sessionId }));
      for (const l of (session as unknown as { listeners: Array<(e: ProviderEvent) => void> })
        .listeners) {
        l({ type: "raw_log", content: raw });
      }
    });

    // Subscribe to SSE events and drive the session
    client.event
      .subscribe({ query: { directory: config.cwd } })
      .then(async ({ stream }) => {
        for await (const event of stream) {
          session.handleOpencodeEvent(event as OpencodeEvent);
        }
        // Stream ended without session.idle — treat as completion
      })
      .catch((err: unknown) => {
        session.handleOpencodeEvent({
          type: "session.error",
          properties: { sessionID: sessionId, error: { message: String(err) } as never },
        });
      });

    // Fire-and-forget: send the prompt to kick off the session
    client.session
      .prompt({
        path: { id: sessionId },
        query: { directory: config.cwd },
        body: {
          parts: [{ type: "text", text: `${config.systemPrompt}\n\n${config.prompt}` }],
        },
      })
      .catch((err: unknown) => {
        session.handleOpencodeEvent({
          type: "session.error",
          properties: { sessionID: sessionId, error: { message: String(err) } as never },
        });
      });

    return session;
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
