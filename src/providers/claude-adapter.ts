import { unlink, writeFile } from "node:fs/promises";
import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";
import type {
  CostData,
  ProviderAdapter,
  ProviderEvent,
  ProviderResult,
  ProviderSession,
  ProviderSessionConfig,
} from "./types";

/** Task file data written to /tmp for hook to read */
interface TaskFileData {
  taskId: string;
  agentId: string;
  startedAt: string;
}

function getTaskFilePath(pid: number): string {
  return `/tmp/agent-swarm-task-${pid}.json`;
}

async function writeTaskFile(pid: number, data: TaskFileData): Promise<string> {
  const filePath = getTaskFilePath(pid);
  await writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

async function cleanupTaskFile(pid: number): Promise<void> {
  try {
    await unlink(getTaskFilePath(pid));
  } catch {
    // File might already be deleted or never created
  }
}

class ClaudeSession implements ProviderSession {
  private proc: ReturnType<typeof Bun.spawn>;
  private listeners: Array<(event: ProviderEvent) => void> = [];
  private eventQueue: ProviderEvent[] = [];
  private _sessionId: string | undefined;
  private completionPromise: Promise<ProviderResult>;
  private errorTracker = new SessionErrorTracker();
  private taskFilePid: number;

  constructor(
    private config: ProviderSessionConfig,
    private model: string,
    taskFilePath: string,
    taskFilePid: number,
  ) {
    this.taskFilePid = taskFilePid;
    const cmd = this.buildCommand();

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m \x1b[36m▸\x1b[0m Spawning Claude (model: ${model}) for task ${config.taskId.slice(0, 8)}`,
    );

    this.proc = Bun.spawn(cmd, {
      cwd: this.config.cwd,
      env: {
        ...(config.env || process.env),
        TASK_FILE: taskFilePath,
      } as Record<string, string>,
      stdout: "pipe",
      stderr: "pipe",
    });

    this.completionPromise = this.processStreams();
  }

  private buildCommand(): string[] {
    const cmd = [
      "claude",
      "--model",
      this.model,
      "--verbose",
      "--output-format",
      "stream-json",
      "--dangerously-skip-permissions",
      "--allow-dangerously-skip-permissions",
      "--permission-mode",
      "bypassPermissions",
      "-p",
      this.config.prompt,
    ];

    if (this.config.additionalArgs?.length) {
      cmd.push(...this.config.additionalArgs);
    }

    if (this.config.systemPrompt) {
      cmd.push("--append-system-prompt", this.config.systemPrompt);
    }

    return cmd;
  }

  private emit(event: ProviderEvent): void {
    if (this.listeners.length > 0) {
      for (const listener of this.listeners) {
        listener(event);
      }
    } else {
      this.eventQueue.push(event);
    }
  }

  private async processStreams(): Promise<ProviderResult> {
    const logFileHandle = Bun.file(this.config.logFile).writer();
    let stderrOutput = "";
    let stdoutChunks = 0;
    let stderrChunks = 0;
    let lastCost: CostData | undefined;
    let partialLine = "";

    const stdoutPromise = (async () => {
      const stdout = this.proc.stdout as ReadableStream<Uint8Array> | null;
      if (!stdout) return;

      for await (const chunk of stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        logFileHandle.write(text);

        const combined = partialLine + text;
        const parts = combined.split("\n");
        partialLine = parts.pop() || "";

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          this.emit({ type: "raw_log", content: trimmed });
          this.processJsonLine(trimmed, (cost) => {
            lastCost = cost;
          });
        }
      }

      // Handle remaining partial line
      if (partialLine.trim()) {
        this.emit({ type: "raw_log", content: partialLine.trim() });
        this.processJsonLine(partialLine.trim(), (cost) => {
          lastCost = cost;
        });
        partialLine = "";
      }
    })();

    const stderrPromise = (async () => {
      const stderr = this.proc.stderr as ReadableStream<Uint8Array> | null;
      if (!stderr) return;

      for await (const chunk of stderr) {
        stderrChunks++;
        const text = new TextDecoder().decode(chunk);
        stderrOutput += text;
        parseStderrForErrors(text, this.errorTracker);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
        );
        this.emit({ type: "raw_stderr", content: text });
      }
    })();

    await Promise.all([stdoutPromise, stderrPromise]);
    await logFileHandle.end();
    const exitCode = await this.proc.exited;

    // Cleanup task file
    await cleanupTaskFile(this.taskFilePid);

    if (exitCode !== 0 && stderrOutput) {
      console.error(
        `\x1b[31m[${this.config.role}] Full stderr for task ${this.config.taskId.slice(0, 8)}:\x1b[0m\n${stderrOutput}`,
      );
    }

    if (stdoutChunks === 0 && stderrChunks === 0) {
      console.warn(
        `\x1b[33m[${this.config.role}] WARNING: No output from Claude for task ${this.config.taskId.slice(0, 8)} - check auth/startup\x1b[0m`,
      );
    }

    let failureReason: string | undefined;
    if (exitCode !== 0 && this.errorTracker.hasErrors()) {
      failureReason = this.errorTracker.buildFailureReason(exitCode ?? 1);
    }

    return {
      exitCode: exitCode ?? 1,
      sessionId: this._sessionId,
      cost: lastCost,
      isError: (exitCode ?? 1) !== 0,
      failureReason,
    };
  }

  private processJsonLine(trimmed: string, setCost: (cost: CostData) => void): void {
    try {
      const json = JSON.parse(trimmed);

      // Session ID from init message
      if (json.type === "system" && json.subtype === "init" && json.session_id) {
        this._sessionId = json.session_id;
        this.emit({ type: "session_init", sessionId: json.session_id });
      }

      // Cost data from result
      if (json.type === "result" && json.total_cost_usd !== undefined) {
        const usage = json.usage as
          | {
              input_tokens?: number;
              output_tokens?: number;
              cache_read_input_tokens?: number;
              cache_creation_input_tokens?: number;
            }
          | undefined;

        const cost: CostData = {
          sessionId: "", // Set by the runner with the appropriate runner session ID
          taskId: this.config.taskId,
          agentId: this.config.agentId,
          totalCostUsd: json.total_cost_usd || 0,
          inputTokens: usage?.input_tokens ?? 0,
          outputTokens: usage?.output_tokens ?? 0,
          cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
          cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
          durationMs: json.duration_ms || 0,
          numTurns: json.num_turns || 1,
          model: this.model,
          isError: json.is_error || false,
        };
        setCost(cost);
        this.emit({
          type: "result",
          cost,
          isError: json.is_error || false,
        });
      }

      trackErrorFromJson(json, this.errorTracker);
    } catch {
      // Not JSON — ignore
    }
  }

  get sessionId(): string | undefined {
    return this._sessionId;
  }

  onEvent(listener: (event: ProviderEvent) => void): void {
    this.listeners.push(listener);
    // Flush queued events
    for (const event of this.eventQueue) {
      listener(event);
    }
    this.eventQueue = [];
  }

  async waitForCompletion(): Promise<ProviderResult> {
    const result = await this.completionPromise;

    // Stale session retry: if process failed because session not found and we used --resume,
    // strip --resume and retry with a fresh session
    if (result.exitCode !== 0 && this.errorTracker.isSessionNotFound()) {
      const hasResume = (this.config.additionalArgs || []).includes("--resume");
      if (hasResume) {
        console.log(
          `\x1b[33m[${this.config.role}] Session not found for task ${this.config.taskId.slice(0, 8)} — retrying without --resume\x1b[0m`,
        );

        const freshArgs = (this.config.additionalArgs || []).filter((arg, idx, arr) => {
          if (arg === "--resume") return false;
          if (idx > 0 && arr[idx - 1] === "--resume") return false;
          return true;
        });

        const logDir = this.config.logFile.substring(0, this.config.logFile.lastIndexOf("/"));
        const retryTimestamp = new Date().toISOString().replace(/[:.]/g, "-");
        const retryLogFile = `${logDir}/${retryTimestamp}-retry-${this.config.taskId.slice(0, 8)}.jsonl`;

        const retryConfig: ProviderSessionConfig = {
          ...this.config,
          additionalArgs: freshArgs,
          logFile: retryLogFile,
          resumeSessionId: undefined,
        };

        // Write new task file for retry
        const taskFilePath = await writeTaskFile(this.taskFilePid, {
          taskId: this.config.taskId,
          agentId: this.config.agentId,
          startedAt: new Date().toISOString(),
        });

        const retrySession = new ClaudeSession(
          retryConfig,
          this.model,
          taskFilePath,
          this.taskFilePid,
        );

        // Forward events from retry to our listeners
        for (const listener of this.listeners) {
          retrySession.onEvent(listener);
        }

        return retrySession.waitForCompletion();
      }
    }

    return result;
  }

  async abort(): Promise<void> {
    this.proc.kill("SIGTERM");
  }
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly name = "claude";

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const model = config.model || "opus";

    const taskFilePid = process.pid;
    const taskFilePath = await writeTaskFile(taskFilePid, {
      taskId: config.taskId,
      agentId: config.agentId,
      startedAt: new Date().toISOString(),
    });

    console.log(`\x1b[2m[${config.role}]\x1b[0m Task file written: ${taskFilePath}`);

    return new ClaudeSession(config, model, taskFilePath, taskFilePid);
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return true;
  }
}
