import {
  type Client,
  ClientSideConnection,
  type ContentBlock,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { scrubSecrets } from "../utils/secret-scrubber";
import { extractAcpUsageMetrics, translateAcpSessionNotification } from "./acp-swarm-events";
import { type AcpArtifactCleanup, type AcpCostProvider, resolveAcpTarget } from "./acp-targets";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

type EventListener = (event: ProviderEvent) => void;
type AcpUsageAccumulator = Partial<
  Pick<
    CostData,
    | "inputTokens"
    | "outputTokens"
    | "cacheReadTokens"
    | "cacheWriteTokens"
    | "reasoningOutputTokens"
    | "thinkingTokens"
    | "totalCostUsd"
  >
>;

class SwarmAcpClient implements Client {
  constructor(private readonly emit: (event: ProviderEvent) => void) {}

  async requestPermission(params: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    const selected =
      params.options.find((option) => option.kind === "allow_always") ??
      params.options.find((option) => option.kind === "allow_once") ??
      params.options[0];
    if (!selected) return { outcome: { outcome: "cancelled" } };
    return { outcome: { outcome: "selected", optionId: selected.optionId } };
  }

  async sessionUpdate(params: SessionNotification): Promise<void> {
    for (const event of translateAcpSessionNotification(params)) {
      this.emit(event);
    }
  }
}

class ACPSession implements ProviderSession {
  readonly sessionId: string;

  private readonly listeners = new Set<EventListener>();
  private readonly pendingEvents: ProviderEvent[] = [];
  private readonly startedAt = Date.now();
  private completed = false;
  private aborted = false;
  private output = "";
  private usage: AcpUsageAccumulator = {};
  private completionPromise: Promise<ProviderResult>;
  private completionResolve!: (result: ProviderResult) => void;

  constructor(
    private readonly connection: ClientSideConnection,
    private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly config: ProviderSessionConfig,
    private readonly diagnostics: AcpProcessDiagnostics,
    private readonly costProvider: AcpCostProvider,
    private readonly prompt: ContentBlock[],
    private readonly artifactCleanup: AcpArtifactCleanup,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
    this.completionPromise = new Promise((resolve) => {
      this.completionResolve = resolve;
    });
    this.diagnostics.onStderr((content) => this.emit({ type: "raw_stderr", content }));
    this.emit({ type: "session_init", sessionId, provider: "acp" });
    this.emit({ type: "raw_log", content: "ACP session ready; starting session/prompt." });
    void this.runPrompt();
  }

  onEvent(listener: EventListener): void {
    this.listeners.add(listener);
    for (const event of this.pendingEvents.splice(0)) {
      listener(event);
    }
  }

  waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    try {
      await this.connection.cancel({ sessionId: this.sessionId });
    } catch (err) {
      this.emit({
        type: "error",
        message: scrubSecrets(`ACP session/cancel failed: ${formatError(err)}`),
        category: "abort",
      });
    }
    this.process.kill();
    this.finish({
      exitCode: 1,
      sessionId: this.sessionId,
      isError: true,
      failureReason: "aborted",
    });
  }

  emitFromAcp(event: ProviderEvent): void {
    this.emit(event);
  }

  private emit(event: ProviderEvent): void {
    if (event.type === "message" && event.role === "assistant") {
      this.output += event.content;
    }
    if (event.type === "custom" && event.name === "acp_usage_update") {
      this.recordUsage(event.data);
    }
    if (this.listeners.size === 0) {
      this.pendingEvents.push(event);
      return;
    }
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  private async runPrompt(): Promise<void> {
    try {
      const response = await this.connection.prompt({
        sessionId: this.sessionId,
        prompt: this.prompt,
      });
      this.recordUsage(response);
      this.emit({
        type: "raw_log",
        content: scrubSecrets(`ACP session/prompt finished with stopReason=${response.stopReason}`),
      });
      const isError = response.stopReason === "refusal" || response.stopReason === "cancelled";
      const cost = this.buildCostData(isError);
      const result: ProviderResult = {
        exitCode: isError ? 1 : 0,
        sessionId: this.sessionId,
        cost,
        output: this.output,
        isError,
        failureReason: isError ? `ACP prompt stopped with ${response.stopReason}` : undefined,
      };
      this.emit({ type: "result", cost, output: this.output, isError });
      this.finish(result);
    } catch (err) {
      const message = scrubSecrets(formatError(err));
      this.emit({ type: "error", message, category: "protocol" });
      this.finish({
        exitCode: 1,
        sessionId: this.sessionId,
        isError: true,
        failureReason: `ACP prompt failed: ${message}`,
      });
    } finally {
      this.process.kill();
      await this.artifactCleanup.cleanup();
    }
  }

  private recordUsage(data: unknown): void {
    const metrics =
      data && typeof data === "object" && "metrics" in data
        ? (data as { metrics?: unknown }).metrics
        : data;
    this.usage = { ...this.usage, ...extractAcpUsageMetrics(metrics) };
  }

  private buildCostData(isError: boolean): CostData {
    return {
      sessionId: this.sessionId,
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: this.usage.totalCostUsd ?? 0,
      durationMs: Date.now() - this.startedAt,
      numTurns: 1,
      model: this.config.model,
      isError,
      provider: this.costProvider as CostData["provider"],
      inputTokens: this.usage.inputTokens,
      outputTokens: this.usage.outputTokens,
      cacheReadTokens: this.usage.cacheReadTokens,
      cacheWriteTokens: this.usage.cacheWriteTokens,
      reasoningOutputTokens: this.usage.reasoningOutputTokens,
      thinkingTokens: this.usage.thinkingTokens,
    };
  }

  private finish(result: ProviderResult): void {
    if (this.completed) return;
    this.completed = true;
    this.completionResolve(result);
  }
}

export class ACPAdapter implements ProviderAdapter {
  readonly name = "acp";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasLocalEnvironment: true,
  };

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const target = resolveAcpTarget(config);
    // Validate all config BEFORE writing any artifacts to disk (Fix #4: invalid
    // config must not leave a secret-bearing system prompt on disk).
    const command = target.command(config);
    const prompt = target.prompt(config);
    const costProvider = target.costProvider(config);
    const env = target.env(config);
    const artifactCleanup = await target.writeSystemPromptArtifact(config);
    const proc = Bun.spawn(command, {
      cwd: config.cwd,
      env,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    const diagnostics = new AcpProcessDiagnostics(proc.stderr);

    let session: ACPSession | null = null;
    const startupEvents: ProviderEvent[] = [];
    const client = new SwarmAcpClient((event) => {
      if (session) {
        session.emitFromAcp(event);
      } else {
        startupEvents.push(event);
      }
    });
    const stream = ndJsonStream(fileSinkWritableStream(proc.stdin), proc.stdout);
    const connection = new ClientSideConnection(() => client, stream);

    let startupStep = "initialize";
    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "agent-swarm", version: "1.88.0" },
        clientCapabilities: {},
      });
      startupStep = "session/new";
      const newSession = await connection.newSession({
        cwd: config.cwd,
        mcpServers: [
          {
            type: "http",
            name: "swarm",
            url: `${config.apiUrl.replace(/\/+$/, "")}/mcp`,
            headers: [
              { name: "Authorization", value: `Bearer ${config.apiKey}` },
              { name: "X-Agent-ID", value: config.agentId },
              { name: "X-Source-Task-Id", value: config.taskId },
            ],
          },
        ],
      });
      session = new ACPSession(
        connection,
        proc,
        config,
        diagnostics,
        costProvider,
        prompt,
        artifactCleanup,
        newSession.sessionId,
      );
      for (const event of startupEvents.splice(0)) {
        session.emitFromAcp(event);
      }
      return session;
    } catch (err) {
      proc.kill();
      diagnostics.close();
      await artifactCleanup.cleanup();
      throw new Error(
        `ACP target failed during ${startupStep}: ${scrubSecrets(formatError(err))}${diagnostics.errorSuffix()}`,
      );
    }
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}

class AcpProcessDiagnostics {
  private readonly listeners = new Set<(content: string) => void>();
  private readonly stderrChunks: string[] = [];
  private closed = false;

  constructor(stderr: ReadableStream<Uint8Array> | null) {
    if (stderr) void this.consume(stderr);
  }

  onStderr(listener: (content: string) => void): void {
    this.listeners.add(listener);
    for (const chunk of this.stderrChunks) {
      listener(chunk);
    }
  }

  close(): void {
    this.closed = true;
  }

  errorSuffix(): string {
    const tail = this.stderrChunks.join("").slice(-2000).trim();
    return tail ? `; stderr tail: ${tail}` : "";
  }

  private async consume(stderr: ReadableStream<Uint8Array>): Promise<void> {
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (!this.closed) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length === 0) continue;
        const content = scrubSecrets(decoder.decode(value));
        this.stderrChunks.push(content);
        while (this.stderrChunks.join("").length > 4000) {
          this.stderrChunks.shift();
        }
        for (const listener of this.listeners) {
          listener(content);
        }
      }
    } catch {
      // Process teardown can close stderr while a read is pending.
    }
  }
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function fileSinkWritableStream(sink: Bun.FileSink): WritableStream<Uint8Array> {
  return new WritableStream<Uint8Array>({
    write(chunk) {
      sink.write(chunk);
      sink.flush();
    },
    close() {
      sink.end();
    },
    abort() {
      sink.end();
    },
  });
}
