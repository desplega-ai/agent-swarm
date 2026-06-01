import {
  type Client,
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import { scrubSecrets } from "../utils/secret-scrubber";
import { translateAcpSessionNotification } from "./acp-swarm-events";
import { resolveAcpTarget } from "./acp-targets";
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
  private completionPromise: Promise<ProviderResult>;
  private completionResolve!: (result: ProviderResult) => void;

  constructor(
    private readonly connection: ClientSideConnection,
    private readonly process: Bun.Subprocess<"pipe", "pipe", "pipe">,
    private readonly config: ProviderSessionConfig,
    sessionId: string,
  ) {
    this.sessionId = sessionId;
    this.completionPromise = new Promise((resolve) => {
      this.completionResolve = resolve;
    });
    this.consumeStderr();
    this.emit({ type: "session_init", sessionId, provider: "acp" });
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
        prompt: [{ type: "text", text: this.config.prompt }],
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
    }
  }

  private async consumeStderr(): Promise<void> {
    const stderr = this.process.stderr;
    if (!stderr) return;
    const reader = stderr.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value.length > 0) {
          this.emit({ type: "raw_stderr", content: scrubSecrets(decoder.decode(value)) });
        }
      }
    } catch {
      // Process teardown can close stderr while a read is pending.
    }
  }

  private buildCostData(isError: boolean): CostData {
    return {
      sessionId: this.sessionId,
      taskId: this.config.taskId,
      agentId: this.config.agentId,
      totalCostUsd: 0,
      durationMs: Date.now() - this.startedAt,
      numTurns: 1,
      model: this.config.model,
      isError,
      provider: "acp",
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
    await target.writeSystemPromptArtifact(config);
    const command = target.command(config);
    const proc = Bun.spawn(command, {
      cwd: config.cwd,
      env: target.env(config),
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });

    let session: ACPSession | null = null;
    const client = new SwarmAcpClient((event) => session?.emitFromAcp(event));
    const stream = ndJsonStream(fileSinkWritableStream(proc.stdin), proc.stdout);
    const connection = new ClientSideConnection(() => client, stream);

    try {
      await connection.initialize({
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: "agent-swarm", version: "1.88.0" },
        clientCapabilities: {},
      });
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
      session = new ACPSession(connection, proc, config, newSession.sessionId);
      return session;
    } catch (err) {
      proc.kill();
      throw new Error(`ACP target failed during startup: ${scrubSecrets(formatError(err))}`);
    }
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
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
