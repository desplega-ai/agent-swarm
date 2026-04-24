import { unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computeContextUsed, getContextWindowSize } from "../utils/context-window";
import { validateClaudeCredentials } from "../utils/credentials";
import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker";
import { scrubSecrets } from "../utils/secret-scrubber";
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

/** Fetch installed MCP servers from the API and return them as .mcp.json-compatible entries */
async function fetchInstalledMcpServers(
  apiUrl: string,
  apiKey: string,
  agentId: string,
): Promise<Record<string, Record<string, unknown>> | null> {
  try {
    const res = await fetch(`${apiUrl}/api/agents/${agentId}/mcp-servers?resolveSecrets=true`, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "X-Agent-ID": agentId,
      },
    });
    if (!res.ok) return null;

    const data = (await res.json()) as {
      servers: Array<{
        name: string;
        transport: string;
        isActive: boolean;
        isEnabled: boolean;
        command?: string;
        args?: string;
        url?: string;
        headers?: string;
        resolvedEnv?: Record<string, string>;
        resolvedHeaders?: Record<string, string>;
      }>;
    };

    const entries: Record<string, Record<string, unknown>> = {};
    for (const srv of data.servers.filter((s) => s.isActive && s.isEnabled)) {
      if (srv.transport === "stdio" && srv.command) {
        let args: string[] = [];
        try {
          args = srv.args ? JSON.parse(srv.args) : [];
        } catch {
          // invalid JSON — use empty args
        }
        entries[srv.name] = {
          command: srv.command,
          args,
          env: srv.resolvedEnv || {},
        };
      } else if ((srv.transport === "http" || srv.transport === "sse") && srv.url) {
        let parsedHeaders: Record<string, string> = {};
        try {
          parsedHeaders = srv.headers ? JSON.parse(srv.headers) : {};
        } catch {
          // invalid JSON — use empty headers
        }
        entries[srv.name] = {
          type: srv.transport,
          url: srv.url,
          headers: { ...parsedHeaders, ...(srv.resolvedHeaders || {}) },
        };
      }
    }
    return Object.keys(entries).length > 0 ? entries : null;
  } catch {
    return null;
  }
}

/**
 * Merge a base MCP config (typically read from `.mcp.json`) with freshly-resolved
 * installed servers from the API, and inject the per-task `X-Source-Task-Id` header
 * into the `agent-swarm` entry.
 *
 * Precedence: installed servers from the API WIN over entries already in `.mcp.json`.
 * This guards against stale credentials from a `.mcp.json` that was written once at
 * container startup and never refreshed (see issue #369). The per-session fetch
 * carries current OAuth tokens / rotated secrets / up-to-date installs.
 *
 * Exported for unit testing.
 */
export function mergeMcpConfig(
  baseConfig: { mcpServers?: Record<string, unknown> } | null,
  installedServers: Record<string, Record<string, unknown>> | null,
  taskId: string,
): { mcpServers: Record<string, unknown> } {
  const config: { mcpServers: Record<string, unknown> } = {
    mcpServers: { ...(baseConfig?.mcpServers ?? {}) },
  };

  // Installed servers from the API always win — fresh credentials replace stale ones.
  if (installedServers) {
    for (const [name, serverConfig] of Object.entries(installedServers)) {
      config.mcpServers[name] = serverConfig;
    }
  }

  // Find the agent-swarm server entry (could be named "agent-swarm" or similar)
  const serverKey = Object.keys(config.mcpServers).find(
    (k) =>
      k === "agent-swarm" ||
      ((config.mcpServers[k] as Record<string, unknown>)?.headers &&
        ((config.mcpServers[k] as Record<string, Record<string, unknown>>).headers?.[
          "X-Agent-ID"
        ] as unknown)),
  );
  if (serverKey) {
    const server = config.mcpServers[serverKey] as Record<string, unknown>;
    if (!server.headers) server.headers = {};
    (server.headers as Record<string, string>)["X-Source-Task-Id"] = taskId;
  }

  return config;
}

/**
 * Create a per-session MCP config file with X-Source-Task-Id header injected
 * and installed MCP servers merged in.
 * Each session gets its own copy to avoid race conditions when multiple concurrent
 * Claude sessions share the same cwd. The session-specific config is passed to
 * Claude CLI via --mcp-config, so the shared .mcp.json is never modified.
 * Returns the path to the per-session config, or null if no config exists.
 */
async function createSessionMcpConfig(
  cwd: string,
  taskId: string,
  installedServers?: Record<string, Record<string, unknown>> | null,
): Promise<string | null> {
  // Walk up from cwd to find .mcp.json (mirrors Claude CLI's project-level config discovery).
  // In Docker, .mcp.json lives at /workspace/.mcp.json but tasks often run with cwd set to
  // a subdirectory like /workspace/repos/<repo>, so a single-directory check misses it.
  let searchDir = cwd;
  let mcpJsonPath: string | null = null;
  while (true) {
    const candidate = join(searchDir, ".mcp.json");
    if (await Bun.file(candidate).exists()) {
      mcpJsonPath = candidate;
      break;
    }
    const parent = dirname(searchDir);
    if (parent === searchDir) break; // reached filesystem root
    searchDir = parent;
  }

  if (!mcpJsonPath && !installedServers) return null;

  try {
    let baseConfig: { mcpServers?: Record<string, unknown> } = { mcpServers: {} };
    if (mcpJsonPath) {
      const file = Bun.file(mcpJsonPath);
      baseConfig = await file.json();
    }
    if (!baseConfig?.mcpServers && !installedServers) return null;

    const config = mergeMcpConfig(baseConfig, installedServers ?? null, taskId);

    // Write per-session config to /tmp — no race, each session has its own file
    const sessionConfigPath = `/tmp/mcp-${taskId}.json`;
    await writeFile(sessionConfigPath, JSON.stringify(config, null, 2));
    return sessionConfigPath;
  } catch (err) {
    // Non-fatal — if creation fails, sourceTaskId won't be sent and Slack metadata won't auto-inherit
    console.warn(`\x1b[33m[claude]\x1b[0m Failed to create session MCP config: ${err}`);
    return null;
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
  private contextWindowSize: number;

  constructor(
    private config: ProviderSessionConfig,
    private model: string,
    taskFilePath: string,
    taskFilePid: number,
    private sessionMcpConfig: string | null = null,
    private claudeBinary: string = "claude",
  ) {
    this.taskFilePid = taskFilePid;
    this.contextWindowSize = getContextWindowSize(model);
    const cmd = this.buildCommand();

    console.log(
      `\x1b[2m[${config.role}]\x1b[0m \x1b[36m▸\x1b[0m Spawning Claude (model: ${model}) for task ${config.taskId.slice(0, 8)}`,
    );

    this.proc = Bun.spawn(cmd, {
      cwd: this.config.cwd,
      env: {
        ENABLE_PROMPT_CACHING_1H: "1",
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
      this.claudeBinary,
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

    // Use per-session MCP config to avoid race conditions with concurrent sessions
    if (this.sessionMcpConfig) {
      cmd.push("--mcp-config", this.sessionMcpConfig, "--strict-mcp-config");
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
        // Scrub before every log-egress point: file write, listener emit, and
        // downstream pretty-print / session-logs push (all consume event.content).
        logFileHandle.write(scrubSecrets(text));

        const combined = partialLine + text;
        const parts = combined.split("\n");
        partialLine = parts.pop() || "";

        for (const line of parts) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          this.emit({ type: "raw_log", content: scrubSecrets(trimmed) });
          this.processJsonLine(trimmed, (cost) => {
            lastCost = cost;
          });
        }
      }

      // Handle remaining partial line
      if (partialLine.trim()) {
        this.emit({ type: "raw_log", content: scrubSecrets(partialLine.trim()) });
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
        const scrubbedText = scrubSecrets(text);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: scrubbedText, timestamp: new Date().toISOString() })}\n`,
        );
        this.emit({ type: "raw_stderr", content: scrubbedText });
      }
    })();

    await Promise.all([stdoutPromise, stderrPromise]);
    await logFileHandle.end();
    const exitCode = await this.proc.exited;

    // Cleanup task file and per-session MCP config
    await cleanupTaskFile(this.taskFilePid);
    if (this.sessionMcpConfig) {
      try {
        await unlink(this.sessionMcpConfig);
      } catch {
        // ignore — temp file may already be gone
      }
    }

    if (exitCode !== 0 && stderrOutput) {
      console.error(
        `\x1b[31m[${this.config.role}] Full stderr for task ${this.config.taskId.slice(0, 8)}:\x1b[0m\n${scrubSecrets(stderrOutput)}`,
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
        if (json.model) {
          this.contextWindowSize = getContextWindowSize(json.model);
        }
      }

      // Compaction detection
      if (json.type === "system" && json.subtype === "compact_boundary" && json.compact_metadata) {
        this.emit({
          type: "compaction",
          preCompactTokens: json.compact_metadata.pre_tokens ?? 0,
          compactTrigger: json.compact_metadata.trigger ?? "auto",
          contextTotalTokens: this.contextWindowSize,
        });
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

        // Update context window size from modelUsage if available
        if (json.modelUsage) {
          const modelKey = Object.keys(json.modelUsage)[0];
          if (modelKey && json.modelUsage[modelKey]?.contextWindow) {
            this.contextWindowSize = json.modelUsage[modelKey].contextWindow;
          }
        }
      }

      // Tool use from assistant messages — emit tool_start for auto-progress
      if (json.type === "assistant" && json.message) {
        const message = json.message as {
          content?: Array<{ type: string; name?: string; id?: string; input?: unknown }>;
        };
        if (message.content) {
          for (const block of message.content) {
            if (block.type === "tool_use" && block.name) {
              this.emit({
                type: "tool_start",
                toolCallId: block.id || "",
                toolName: block.name,
                args: block.input || {},
              });
            }
          }
        }

        // Context usage extraction from assistant message usage
        if (json.message.usage) {
          const usage = json.message.usage;
          const contextUsed = computeContextUsed(usage);
          const contextTotal = this.contextWindowSize;

          this.emit({
            type: "context_usage",
            contextUsedTokens: contextUsed,
            contextTotalTokens: contextTotal,
            contextPercent: contextTotal > 0 ? (contextUsed / contextTotal) * 100 : 0,
            outputTokens: usage.output_tokens ?? 0,
          });
        }
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
          null,
          this.claudeBinary,
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

    const credType = validateClaudeCredentials(config.env || process.env);
    console.log(`\x1b[2m[claude]\x1b[0m Using credential: ${credType}`);

    // Resolve claude binary: CLAUDE_BINARY env var > "claude" (PATH lookup)
    const claudeBinary = process.env.CLAUDE_BINARY || "claude";

    const taskFilePid = process.pid;
    const taskFilePath = await writeTaskFile(taskFilePid, {
      taskId: config.taskId,
      agentId: config.agentId,
      startedAt: new Date().toISOString(),
    });

    console.log(`\x1b[2m[${config.role}]\x1b[0m Task file written: ${taskFilePath}`);

    // Fetch installed MCP servers from API for this agent
    const installedServers =
      config.apiUrl && config.apiKey && config.agentId
        ? await fetchInstalledMcpServers(config.apiUrl, config.apiKey, config.agentId)
        : null;
    if (installedServers) {
      console.log(
        `\x1b[2m[${config.role}]\x1b[0m Merging ${Object.keys(installedServers).length} installed MCP server(s) into session config`,
      );
    }

    // Create per-session MCP config with X-Source-Task-Id header + installed servers (no shared-file race condition)
    const sessionMcpConfig = await createSessionMcpConfig(
      config.cwd,
      config.taskId,
      installedServers,
    );

    return new ClaudeSession(
      config,
      model,
      taskFilePath,
      taskFilePid,
      sessionMcpConfig,
      claudeBinary,
    );
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return true;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
