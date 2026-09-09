import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import {
  type Query,
  query,
  type SDKMessage,
  type SDKResultMessage,
  type SDKUserMessage,
  type SpawnedProcess,
  type SpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { RunStopHookSessionSummaryOpts } from "../hooks/hook";
import { getContextWindowSize } from "../utils/context-window";
import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";
import {
  detachedProcessGroup,
  registerProcessGroup,
  signalProcessGroup,
  terminateProcessGroup,
} from "../utils/process-group";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  buildClaudeSessionEnvironment,
  cleanupTaskFile,
  runClaudeSessionSummary,
} from "./claude-adapter";
import type { ClaudeProtocolMessage } from "./claude-session-events";
import { normalizeClaudeMessage } from "./claude-session-events";
import type {
  CostData,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
  SteerDelivery,
  SteerDeliveryResult,
} from "./types";

const PROTOCOL_FLAGS = new Set([
  "-p",
  "--print",
  "--input-format",
  "--output-format",
  "--resume",
  "--continue",
  "-r",
  "-c",
  "--fork-session",
  "--resume-session-at",
  "--resume-drops-turn",
  "--session-id",
  "--mcp-config",
  "--strict-mcp-config",
  "--append-system-prompt",
  "--append-system-prompt-file",
]);

const SDK_GRACEFUL_SHUTDOWN_MS = 2_250;
const SDK_INTERRUPT_TIMEOUT_MS = 1_000;

export function validateClaudeSdkAdditionalArgs(args: readonly string[]): void {
  for (const arg of args) {
    const flag = arg.startsWith("--") ? arg.split("=", 1)[0] : arg;
    if (flag && PROTOCOL_FLAGS.has(flag)) {
      throw new Error(
        `Claude SDK transport does not accept '${flag}' in additional arguments because it controls the SDK protocol or native continuation.`,
      );
    }
  }
}

export function resolveClaudeSdkExecutable(binary: string, path?: string): string {
  if (binary.includes("/") || binary.includes("\\")) return binary;
  const resolved = path !== undefined ? Bun.which(binary, { PATH: path }) : Bun.which(binary);
  if (resolved) return resolved;
  throw new Error(`Claude SDK executable '${binary}' was not found on PATH.`);
}

type QueueEntry = {
  message: SDKUserMessage;
  accepted?: () => void;
  rejected?: (error: Error) => void;
};

export class ClaudeInputQueue implements AsyncIterable<SDKUserMessage> {
  private entries: QueueEntry[] = [];
  private inFlightEntries = new Set<QueueEntry>();
  private waiters: Array<() => void> = [];
  private closed = false;
  private inFlight = 0;

  get pendingCount(): number {
    return this.entries.length + this.inFlight;
  }

  enqueue(text: string): Promise<void> {
    if (this.closed) return Promise.reject(new Error("Claude SDK input is closed"));
    return new Promise((accepted, rejected) => {
      this.entries.push({
        message: {
          type: "user",
          message: { role: "user", content: text },
          parent_tool_use_id: null,
        },
        accepted,
        rejected,
      });
      this.waiters.shift()?.();
    });
  }

  close(reason = "Claude SDK input is closed"): void {
    this.closed = true;
    const error = new Error(reason);
    for (const entry of this.entries.splice(0)) entry.rejected?.(error);
    for (const entry of this.inFlightEntries) entry.rejected?.(error);
    this.inFlightEntries.clear();
    for (const wake of this.waiters.splice(0)) wake();
  }

  async *[Symbol.asyncIterator](): AsyncIterator<SDKUserMessage> {
    while (true) {
      const entry = this.entries.shift();
      if (entry) {
        this.inFlight++;
        this.inFlightEntries.add(entry);
        yield entry.message;
        this.inFlight--;
        this.inFlightEntries.delete(entry);
        if (!this.closed) entry.accepted?.();
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

type BunProcessAdapter = SpawnedProcess & {
  pid: number;
  exited: Promise<number>;
  stderrDone: Promise<void>;
};

export function spawnClaudeSdkProcess(
  options: SpawnOptions,
  binaryPrefix: readonly string[],
  additionalArgs: readonly string[],
  finalArgs: readonly string[],
  onStderr: (text: string) => void,
): BunProcessAdapter {
  const [command, ...args] = buildClaudeSdkCommand(
    options,
    binaryPrefix,
    additionalArgs,
    finalArgs,
  );
  if (!command) throw new Error("Claude SDK process command is empty");
  const proc = registerProcessGroup(
    Bun.spawn([command, ...args], {
      cwd: options.cwd,
      detached: detachedProcessGroup,
      env: options.env as Record<string, string>,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    }),
  );
  const emitter = new EventEmitter();
  let exitCode: number | null = null;
  let signalCode: NodeJS.Signals | null = null;

  const stderr = proc.stderr as ReadableStream<Uint8Array> | null;
  const stderrDone = stderr
    ? (async () => {
        for await (const chunk of stderr) onStderr(new TextDecoder().decode(chunk));
      })().catch((error) => onStderr(`Claude SDK stderr read failed: ${String(error)}\n`))
    : Promise.resolve();

  options.signal.addEventListener(
    "abort",
    () => {
      try {
        signalProcessGroup(proc.pid, "SIGKILL");
      } catch {
        // The process group may have exited during the SDK grace period.
      }
    },
    { once: true },
  );

  void proc.exited.then(
    (code) => {
      exitCode = code;
      emitter.emit("exit", code, signalCode);
    },
    (error) => emitter.emit("error", error instanceof Error ? error : new Error(String(error))),
  );

  const sink = proc.stdin;
  if (!sink || typeof sink === "number") throw new Error("Claude SDK process stdin is unavailable");
  const stdin = new Writable({
    write(chunk, _encoding, callback) {
      try {
        sink.write(chunk);
        void Promise.resolve(sink.flush()).then(() => callback(), callback);
      } catch (error) {
        callback(error as Error);
      }
    },
    final(callback) {
      try {
        void Promise.resolve(sink.end()).then(() => callback(), callback);
      } catch (error) {
        callback(error as Error);
      }
    },
  });
  const stdoutWeb = proc.stdout as ReadableStream<Uint8Array> | null;
  if (!stdoutWeb) throw new Error("Claude SDK process stdout is unavailable");

  return {
    pid: proc.pid,
    exited: proc.exited,
    stderrDone,
    stdin,
    stdout: Readable.fromWeb(stdoutWeb as never),
    get killed() {
      return proc.killed;
    },
    get exitCode() {
      return exitCode;
    },
    get signalCode() {
      return signalCode;
    },
    kill(signal) {
      signalCode = signal;
      return signalProcessGroup(proc.pid, signal);
    },
    on(event, listener) {
      emitter.on(event, listener);
    },
    once(event, listener) {
      emitter.once(event, listener);
    },
    off(event, listener) {
      emitter.off(event, listener);
    },
  };
}

export function buildClaudeSdkCommand(
  options: Pick<SpawnOptions, "command" | "args">,
  binaryPrefix: readonly string[],
  additionalArgs: readonly string[],
  finalArgs: readonly string[],
): string[] {
  const sdkCommand = [options.command, ...options.args];
  const executable = binaryPrefix[0];
  const prefixArgs = binaryPrefix.slice(1);
  let baseCommand = sdkCommand;
  if (executable && prefixArgs.length > 0) {
    baseCommand =
      options.args[0] === executable
        ? [options.command, executable, ...prefixArgs, ...options.args.slice(1)]
        : [executable, ...prefixArgs, ...options.args];
  }
  return [...baseCommand, ...additionalArgs, ...finalArgs];
}

export type CreateClaudeSdkSessionOptions = {
  config: ProviderSessionConfig;
  model: string;
  taskFilePath: string;
  taskFileKey: string;
  sessionMcpConfig: string | null;
  claudeBinaryArgv: readonly string[];
  systemPromptFile: string | null;
  harnessVariant?: string;
  harnessVariantMeta?: Record<string, unknown>;
  queueSteeringSupported: boolean;
  runSessionSummary: (opts: RunStopHookSessionSummaryOpts) => Promise<void>;
};

export async function createClaudeSdkSession(
  options: CreateClaudeSdkSessionOptions,
): Promise<ProviderSession> {
  validateClaudeSdkAdditionalArgs([
    ...options.claudeBinaryArgv.slice(1),
    ...(options.config.additionalArgs ?? []),
  ]);
  return new ClaudeSdkSession(options);
}

class ClaudeSdkSession implements ProviderSession {
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private eventQueue: ProviderEvent[] = [];
  private input = new ClaudeInputQueue();
  private abortController = new AbortController();
  private query: Query | undefined;
  private spawnedProcess: BunProcessAdapter | undefined;
  private completionPromise: Promise<ProviderResult>;
  private _sessionId: string | undefined;
  private model: string;
  private contextWindowSize: number;
  private transcript: string[];
  private lastAssistantText = "";
  private lastCost: CostData | undefined;
  private aborted = false;
  private abortReason = "cancelled";
  private acceptingInput = true;
  private errorTracker = new SessionErrorTracker();
  private shutdownPromise: Promise<void> | undefined;

  constructor(private options: CreateClaudeSdkSessionOptions) {
    this.model = options.model;
    this.contextWindowSize = getContextWindowSize(options.model);
    this.transcript = [`User: ${scrubSecrets(options.config.prompt)}`];
    if (options.queueSteeringSupported) {
      this.deliverSteering = (delivery) => this.deliverQueuedSteering(delivery);
    }
    this.completionPromise = this.run();
  }

  readonly deliverSteering?: (delivery: SteerDelivery) => Promise<SteerDeliveryResult>;

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    for (const event of this.eventQueue) listener(event);
    this.eventQueue.length = 0;
  }

  waitForCompletion(): Promise<ProviderResult> {
    return this.completionPromise;
  }

  async abort(reason?: string): Promise<void> {
    if (this.aborted) return;
    this.aborted = true;
    this.acceptingInput = false;
    this.abortReason = scrubSecrets(reason ?? "cancelled");
    const interrupt = this.query?.interrupt();
    if (interrupt) {
      await Promise.race([interrupt.catch(() => undefined), Bun.sleep(SDK_INTERRUPT_TIMEOUT_MS)]);
    }
    this.input.close(this.abortReason);
    this.abortController.abort(this.abortReason);
    await this.shutdownAfterSdkGrace();
  }

  private async deliverQueuedSteering({ mode, text }: SteerDelivery): Promise<SteerDeliveryResult> {
    if (!this.acceptingInput || this.aborted) {
      return { delivered: false, reason: "Claude SDK session has completed" };
    }
    if (mode === "steer") {
      return {
        delivered: false,
        reason: "Claude SDK transport currently supports queued input only",
      };
    }
    try {
      this.transcript.push(`User: ${scrubSecrets(text)}`);
      await this.input.enqueue(text);
      return { delivered: true, mode: "queue" };
    } catch (error) {
      return { delivered: false, reason: scrubSecrets(String(error)) };
    }
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) listener(event);
    } else {
      this.eventQueue.push(event);
    }
  }

  private shutdownAfterSdkGrace(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      const process = this.spawnedProcess;
      if (process) {
        const exited = await Promise.race([
          process.exited.then(
            () => true,
            () => true,
          ),
          Bun.sleep(SDK_GRACEFUL_SHUTDOWN_MS).then(() => false),
        ]);
        if (!exited) await terminateProcessGroup(process.pid);
      }
      this.query?.close();
    })();
    return this.shutdownPromise;
  }

  private handleMessage(message: SDKMessage): boolean {
    const json = message as unknown as ClaudeProtocolMessage;
    const normalized = normalizeClaudeMessage(json, {
      taskId: this.options.config.taskId,
      agentId: this.options.config.agentId,
      model: this.model,
      contextWindowSize: this.contextWindowSize,
      harnessVariant: this.options.harnessVariant,
      harnessVariantMeta: this.options.harnessVariantMeta,
      transport: "sdk",
    });
    if (normalized.sessionId) this._sessionId = normalized.sessionId;
    if (normalized.model) this.model = normalized.model;
    if (normalized.contextWindowSize) this.contextWindowSize = normalized.contextWindowSize;
    if (normalized.cost) this.lastCost = normalized.cost;
    if (normalized.assistantText) this.lastAssistantText = normalized.assistantText;
    this.transcript.push(...normalized.transcriptEntries);
    for (const event of normalized.events) this.emit(event);
    trackErrorFromJson(json, this.errorTracker);
    return normalized.isResult;
  }

  private async run(): Promise<ProviderResult> {
    const config = this.options.config;
    const sessionEnvironment = buildClaudeSessionEnvironment(
      config,
      this.model,
      this.options.taskFilePath,
    );
    const log = Bun.file(config.logFile).writer();
    let terminalResult: SDKResultMessage | undefined;
    let terminalError: unknown;
    let stderrOutput = "";

    void this.input.enqueue(config.prompt).catch(() => {});
    try {
      const executable = resolveClaudeSdkExecutable(
        this.options.claudeBinaryArgv[0] ?? "claude",
        sessionEnvironment.env.PATH,
      );
      const binaryPrefix = [executable, ...this.options.claudeBinaryArgv.slice(1)];
      const finalArgs = [
        ...(this.options.systemPromptFile
          ? ["--append-system-prompt-file", this.options.systemPromptFile]
          : config.systemPrompt
            ? ["--append-system-prompt", config.systemPrompt]
            : []),
        ...(this.options.sessionMcpConfig
          ? ["--mcp-config", this.options.sessionMcpConfig, "--strict-mcp-config"]
          : []),
      ];
      this.query = query({
        prompt: this.input,
        options: {
          abortController: this.abortController,
          cwd: config.cwd,
          env: sessionEnvironment.env,
          model: this.model,
          pathToClaudeCodeExecutable: executable,
          systemPrompt: { type: "preset", preset: "claude_code" },
          settingSources: ["user", "project", "local"],
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          stderr: (text) => {
            const scrubbed = scrubSecrets(text);
            log.write(
              `${JSON.stringify({ type: "stderr", content: scrubbed, timestamp: new Date().toISOString() })}\n`,
            );
            this.emit({ type: "raw_stderr", content: scrubbed });
          },
          spawnClaudeCodeProcess: (spawnOptions) => {
            this.spawnedProcess = spawnClaudeSdkProcess(
              spawnOptions,
              binaryPrefix,
              config.additionalArgs ?? [],
              finalArgs,
              (text) => {
                stderrOutput += text;
                parseStderrForErrors(text, this.errorTracker);
                const scrubbed = scrubSecrets(text);
                log.write(
                  `${JSON.stringify({ type: "stderr", content: scrubbed, timestamp: new Date().toISOString() })}\n`,
                );
                this.emit({ type: "raw_stderr", content: scrubbed });
              },
            );
            return this.spawnedProcess;
          },
        },
      });

      for await (const message of this.query) {
        const scrubbed = scrubSecrets(JSON.stringify(message));
        log.write(`${scrubbed}\n`);
        this.emit({ type: "raw_log", content: scrubbed });
        const isResult = this.handleMessage(message);
        if (!isResult) continue;
        terminalResult = message as SDKResultMessage;
        if ((terminalResult.queued_turn_count ?? 0) === 0 && this.input.pendingCount === 0) {
          this.acceptingInput = false;
          this.input.close();
        }
      }
    } catch (error) {
      terminalError = error;
      if (!this.aborted) {
        const message = scrubSecrets(error instanceof Error ? error.message : String(error));
        this.emit({ type: "error", message, category: "sdk_transport" });
      }
    } finally {
      this.acceptingInput = false;
      this.input.close();
      if (this.aborted) {
        await this.shutdownAfterSdkGrace().catch(() => {});
      } else {
        this.query?.close();
        if (this.spawnedProcess) {
          await terminateProcessGroup(this.spawnedProcess.pid).catch(() => {});
        }
      }
      await this.spawnedProcess?.stderrDone;
      await runClaudeSessionSummary(config, this.transcript, this.options.runSessionSummary);
      await cleanupTaskFile(this.options.taskFileKey);
      for (const path of [this.options.sessionMcpConfig, this.options.systemPromptFile]) {
        if (!path) continue;
        try {
          await Bun.file(path).delete();
        } catch {
          // The session hook may have removed a temporary file first.
        }
      }
      await log.end();
    }

    if (this.aborted) {
      return {
        exitCode: 130,
        sessionId: this._sessionId,
        cost: this.lastCost,
        output: this.lastAssistantText || undefined,
        isError: true,
        errorCategory: "cancelled",
        failureReason: this.abortReason,
        appliedReasoningEffort: sessionEnvironment.appliedReasoningEffort,
      };
    }

    const resultIsError =
      Boolean(terminalError) ||
      !terminalResult ||
      terminalResult.subtype !== "success" ||
      terminalResult.is_error === true;
    const failureReason = resultIsError
      ? scrubSecrets(
          (terminalResult && "errors" in terminalResult ? terminalResult.errors.join("\n") : "") ||
            (terminalResult && "result" in terminalResult ? terminalResult.result : "") ||
            (this.errorTracker.hasErrors()
              ? this.errorTracker.buildFailureReason(1)
              : stderrOutput) ||
            (terminalError instanceof Error
              ? terminalError.message
              : String(terminalError ?? "")) ||
            "Claude SDK session failed",
        )
      : undefined;
    return {
      exitCode: resultIsError ? 1 : 0,
      sessionId: this._sessionId,
      cost: this.lastCost,
      output:
        this.lastAssistantText ||
        (terminalResult && "result" in terminalResult ? terminalResult.result : undefined),
      isError: resultIsError,
      errorCategory: resultIsError ? (terminalResult?.subtype ?? "sdk_transport") : undefined,
      failureReason,
      rateLimitResetAt: this.errorTracker.getRateLimitResetAt(),
      rateLimitWindows: this.errorTracker.getRateLimitWindows(),
      appliedReasoningEffort: sessionEnvironment.appliedReasoningEffort,
    };
  }
}
