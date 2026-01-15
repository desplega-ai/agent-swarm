import { mkdir, unlink, writeFile } from "node:fs/promises";
import { getBasePrompt } from "../prompts/base-prompt.ts";
import { prettyPrintLine, prettyPrintStderr } from "../utils/pretty-print.ts";

/** Task file data written to /tmp for hook to read */
interface TaskFileData {
  taskId: string;
  agentId: string;
  startedAt: string;
}

/** Get the task file path for a given PID */
function getTaskFilePath(pid: number): string {
  return `/tmp/agent-swarm-task-${pid}.json`;
}

/** Write task file before spawning Claude process */
async function writeTaskFile(pid: number, data: TaskFileData): Promise<string> {
  const filePath = getTaskFilePath(pid);
  await writeFile(filePath, JSON.stringify(data, null, 2));
  return filePath;
}

/** Clean up task file after process exits */
async function cleanupTaskFile(pid: number): Promise<void> {
  try {
    await unlink(getTaskFilePath(pid));
  } catch {
    // File might already be deleted or never created - ignore
  }
}

/** Save PM2 process list for persistence across container restarts */
async function savePm2State(role: string): Promise<void> {
  try {
    console.log(`[${role}] Saving PM2 process list...`);
    await Bun.$`pm2 save`.quiet();
    console.log(`[${role}] PM2 state saved`);
  } catch {
    // PM2 not available or no processes - silently ignore
  }
}

/** API configuration for ping/close */
interface ApiConfig {
  apiUrl: string;
  apiKey: string;
  agentId: string;
}

/** Ping the server to indicate activity and update status */
async function pingServer(config: ApiConfig, _role: string): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    await fetch(`${config.apiUrl}/ping`, {
      method: "POST",
      headers,
    });
  } catch {
    // Silently fail - server might not be running
  }
}

/** Mark agent as offline on shutdown */
async function closeAgent(config: ApiConfig, role: string): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    console.log(`[${role}] Marking agent as offline...`);
    await fetch(`${config.apiUrl}/close`, {
      method: "POST",
      headers,
    });
    console.log(`[${role}] Agent marked as offline`);
  } catch {
    // Silently fail - server might not be running
  }
}

/** Setup signal handlers for graceful shutdown */
function setupShutdownHandlers(
  role: string,
  apiConfig?: ApiConfig,
  getRunnerState?: () => RunnerState | undefined,
): void {
  const shutdown = async (signal: string) => {
    console.log(`\n[${role}] Received ${signal}, shutting down...`);

    // Wait for active tasks with timeout
    const state = getRunnerState?.();
    if (state && state.activeTasks.size > 0) {
      const shutdownTimeout = parseInt(process.env.SHUTDOWN_TIMEOUT || "30000", 10);
      console.log(
        `[${role}] Waiting for ${state.activeTasks.size} active tasks to complete (${shutdownTimeout / 1000}s timeout)...`,
      );
      const deadline = Date.now() + shutdownTimeout;

      while (state.activeTasks.size > 0 && Date.now() < deadline) {
        await checkCompletedProcesses(state, role);
        if (state.activeTasks.size > 0) {
          await Bun.sleep(500);
        }
      }

      // Force kill remaining tasks
      if (state.activeTasks.size > 0) {
        console.log(`[${role}] Force stopping ${state.activeTasks.size} remaining task(s)...`);
        for (const [taskId, task] of state.activeTasks) {
          console.log(`[${role}] Force stopping task ${taskId.slice(0, 8)}`);
          task.process.kill("SIGTERM");
        }
      }
    }

    if (apiConfig) {
      await closeAgent(apiConfig, role);
    }
    await savePm2State(role);
    process.exit(0);
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Configuration for a runner role (worker or lead) */
export interface RunnerConfig {
  /** Role name for logging, e.g., "worker" or "lead" */
  role: string;
  /** Default prompt if none provided */
  defaultPrompt: string;
  /** Metadata type for log files, e.g., "worker_metadata" */
  metadataType: string;
  /** Optional capabilities of the agent */
  capabilities?: string[];
}

export interface RunnerOptions {
  prompt?: string;
  yolo?: boolean;
  systemPrompt?: string;
  systemPromptFile?: string;
  logsDir?: string;
  additionalArgs?: string[];
  aiLoop?: boolean; // Use AI-based loop (old behavior)
}

interface RunClaudeIterationOptions {
  prompt: string;
  logFile: string;
  systemPrompt?: string;
  additionalArgs?: string[];
  role: string;
  // New fields for log streaming
  apiUrl?: string;
  apiKey?: string;
  agentId?: string;
  sessionId?: string;
  iteration?: number;
  taskId?: string;
}

/** Running task state for parallel execution */
interface RunningTask {
  taskId: string;
  process: ReturnType<typeof Bun.spawn>;
  logFile: string;
  startTime: Date;
  promise: Promise<number>;
}

/** Runner state for tracking concurrent tasks */
interface RunnerState {
  activeTasks: Map<string, RunningTask>;
  maxConcurrent: number;
}

/** Buffer for session logs */
interface LogBuffer {
  lines: string[];
  lastFlush: number;
}

/** Configuration for log streaming */
const LOG_BUFFER_SIZE = 50; // Flush after this many lines
const LOG_FLUSH_INTERVAL_MS = 5000; // Flush every 5 seconds

/** Push buffered logs to the API */
async function flushLogBuffer(
  buffer: LogBuffer,
  opts: {
    apiUrl: string;
    apiKey: string;
    agentId: string;
    sessionId: string;
    iteration: number;
    taskId?: string;
    cli?: string;
  },
): Promise<void> {
  if (buffer.lines.length === 0) return;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  try {
    const response = await fetch(`${opts.apiUrl}/api/session-logs`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        sessionId: opts.sessionId,
        iteration: opts.iteration,
        taskId: opts.taskId,
        cli: opts.cli || "claude",
        lines: buffer.lines,
      }),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to push logs: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error pushing logs: ${error}`);
  }

  // Clear buffer after flush
  buffer.lines = [];
  buffer.lastFlush = Date.now();
}

/** Trigger types returned by the poll API */
interface Trigger {
  type:
    | "task_assigned"
    | "task_offered"
    | "unread_mentions"
    | "pool_tasks_available"
    | "tasks_finished"
    | "slack_inbox_message";
  taskId?: string;
  task?: unknown;
  mentionsCount?: number;
  count?: number;
  tasks?: Array<{
    id: string;
    agentId?: string;
    task: string;
    status: string;
    output?: string;
    failureReason?: string;
    slackChannelId?: string;
  }>;
  messages?: Array<{
    id: string;
    content: string;
  }>;
}

/** Options for polling */
interface PollOptions {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  pollInterval: number;
  pollTimeout: number;
  since?: string; // Optional: for filtering finished tasks
}

/** Register agent via HTTP API */
async function registerAgent(opts: {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  name: string;
  isLead: boolean;
  capabilities?: string[];
  maxTasks?: number;
}): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  const response = await fetch(`${opts.apiUrl}/api/agents`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      name: opts.name,
      isLead: opts.isLead,
      capabilities: opts.capabilities,
      maxTasks: opts.maxTasks,
    }),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to register agent: ${response.status} ${error}`);
  }
}

/** Poll for triggers via HTTP API */
async function pollForTrigger(opts: PollOptions): Promise<Trigger | null> {
  const startTime = Date.now();
  const headers: Record<string, string> = {
    "X-Agent-ID": opts.agentId,
  };
  if (opts.apiKey) {
    headers.Authorization = `Bearer ${opts.apiKey}`;
  }

  while (Date.now() - startTime < opts.pollTimeout) {
    try {
      // Build URL with optional since parameter
      let url = `${opts.apiUrl}/api/poll`;
      if (opts.since) {
        url += `?since=${encodeURIComponent(opts.since)}`;
      }

      const response = await fetch(url, {
        method: "GET",
        headers,
      });

      if (!response.ok) {
        console.warn(`[runner] Poll request failed: ${response.status}`);
        await Bun.sleep(opts.pollInterval);
        continue;
      }

      const data = (await response.json()) as { trigger: Trigger | null };
      if (data.trigger) {
        return data.trigger;
      }
    } catch (error) {
      console.warn(`[runner] Poll request error: ${error}`);
    }

    await Bun.sleep(opts.pollInterval);
  }

  return null; // Timeout reached, no trigger found
}

/** Build prompt based on trigger type */
function buildPromptForTrigger(trigger: Trigger, defaultPrompt: string): string {
  switch (trigger.type) {
    case "task_assigned": {
      // Use the work-on-task command with task ID and description
      const taskDesc =
        trigger.task && typeof trigger.task === "object" && "task" in trigger.task
          ? (trigger.task as { task: string }).task
          : null;
      let prompt = `/work-on-task ${trigger.taskId}`;
      if (taskDesc) {
        prompt += `\n\nTask: "${taskDesc}"`;
      }
      prompt += `\n\nWhen done, use \`store-progress\` with status: "completed" and include your output.`;
      return prompt;
    }

    case "task_offered": {
      // Use the review-offered-task command with context
      const taskDesc =
        trigger.task && typeof trigger.task === "object" && "task" in trigger.task
          ? (trigger.task as { task: string }).task
          : null;
      let prompt = `/review-offered-task ${trigger.taskId}`;
      if (taskDesc) {
        prompt += `\n\nA task has been offered to you:\n"${taskDesc}"`;
      }
      prompt += `\n\nAccept if you have capacity and skills. Reject with a reason if you cannot handle it.`;
      return prompt;
    }

    case "unread_mentions":
      // Check messages - numbered steps for clarity
      return `You have ${trigger.count || "unread"} mention(s) in chat channels.

1. Use \`read-messages\` with unreadOnly: true to see them
2. Respond to questions or requests directed at you
3. If a message requires work, create a task using \`send-task\``;

    case "pool_tasks_available":
      // Worker: claim a task from the pool - numbered steps for clarity
      return `${trigger.count} task(s) available in the pool.

1. Run \`get-tasks\` with unassigned: true to browse
2. Pick one matching your skills
3. Run \`task-action\` with action: "claim" and taskId: "<id>"

Note: Claims are first-come-first-serve. If claim fails, pick another.`;

    case "tasks_finished": {
      // Lead: notification about finished tasks with inline details
      if (trigger.tasks && Array.isArray(trigger.tasks) && trigger.tasks.length > 0) {
        const completed = trigger.tasks.filter((t) => t.status === "completed");
        const failed = trigger.tasks.filter((t) => t.status === "failed");

        let prompt = `${trigger.count} task(s) finished:\n`;

        if (completed.length > 0) {
          prompt += "\n### Completed:\n";
          for (const t of completed) {
            const agentName = t.agentId ? `Agent ${t.agentId.slice(0, 8)}` : "Unknown";
            const output = t.output ? t.output.slice(0, 200) : "(no output)";
            const hasSlack = t.slackChannelId ? " [Slack - user expects reply]" : "";
            prompt += `- **Task ${t.id.slice(0, 8)}** by ${agentName}${hasSlack}\n`;
            prompt += `  Description: "${t.task?.slice(0, 100)}"\n`;
            prompt += `  Output: ${output}${t.output && t.output.length > 200 ? "..." : ""}\n`;
          }
        }

        if (failed.length > 0) {
          prompt += "\n### Failed:\n";
          for (const t of failed) {
            const agentName = t.agentId ? `Agent ${t.agentId.slice(0, 8)}` : "Unknown";
            const reason = t.failureReason || "(no reason given)";
            const hasSlack = t.slackChannelId ? " [Slack - user expects reply]" : "";
            prompt += `- **Task ${t.id.slice(0, 8)}** by ${agentName}${hasSlack}\n`;
            prompt += `  Description: "${t.task?.slice(0, 100)}"\n`;
            prompt += `  Reason: ${reason}\n`;
          }
        }

        prompt += `\nFor each task:
1. Completed: Verify output meets requirements
2. Failed: Reassign to another worker, or handle the issue
3. If Slack context: Use \`slack-reply\` with taskId to update the user`;

        return prompt;
      }

      return `Workers have finished ${trigger.count} task(s). Use \`get-tasks\` with status: "completed" or "failed" to review them.`;
    }

    case "slack_inbox_message": {
      // Lead: Slack inbox messages from users
      const inboxDetails = (trigger.messages || [])
        .map((m: { id: string; content: string }, index: number) => {
          // Parse structured content if present
          const newMessageMatch = m.content.match(/<new_message>\n([\s\S]*?)\n<\/new_message>/);
          const threadHistoryMatch = m.content.match(
            /<thread_history>\n([\s\S]*?)\n<\/thread_history>/,
          );

          const newMessage = newMessageMatch ? newMessageMatch[1] : m.content;
          const threadHistory = threadHistoryMatch ? threadHistoryMatch[1] : null;

          let formatted = `### Message ${index + 1} (inboxMessageId: ${m.id})\n`;
          formatted += `**New Message:**\n${newMessage}\n`;

          if (threadHistory) {
            formatted += `\n**Thread History:**\n${threadHistory}\n`;
          }

          return formatted;
        })
        .join("\n---\n\n");

      return `${trigger.count} Slack inbox message(s):\n\n${inboxDetails}\n\nFor each message, choose one:
- **Reply directly**: Use \`slack-reply\` with inboxMessageId if you can answer immediately
- **Delegate to worker**: Use \`inbox-delegate\` with inboxMessageId and agentId if it requires work

Do not leave messages unanswered.`;
    }

    default:
      return defaultPrompt;
  }
}

async function runClaudeIteration(opts: RunClaudeIterationOptions): Promise<number> {
  const { role } = opts;
  const Cmd = [
    "claude",
    "--model",
    "opus",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "-p",
    opts.prompt,
  ];

  if (opts.additionalArgs && opts.additionalArgs.length > 0) {
    Cmd.push(...opts.additionalArgs);
  }

  if (opts.systemPrompt) {
    Cmd.push("--append-system-prompt", opts.systemPrompt);
  }

  console.log(`\x1b[2m[${role}]\x1b[0m \x1b[36m▸\x1b[0m Starting Claude (PID will follow)`);

  const logFileHandle = Bun.file(opts.logFile).writer();
  let stderrOutput = "";

  const proc = Bun.spawn(Cmd, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutChunks = 0;
  let stderrChunks = 0;

  const stdoutPromise = (async () => {
    if (proc.stdout) {
      // Initialize log buffer for API streaming
      const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now() };
      const shouldStream = opts.apiUrl && opts.sessionId && opts.iteration;

      for await (const chunk of proc.stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        logFileHandle.write(text);

        const lines = text.split("\n");
        for (const line of lines) {
          prettyPrintLine(line, role);

          // Buffer non-empty lines for API streaming
          if (shouldStream && line.trim()) {
            logBuffer.lines.push(line.trim());

            // Check if we should flush (buffer full or time elapsed)
            const shouldFlush =
              logBuffer.lines.length >= LOG_BUFFER_SIZE ||
              Date.now() - logBuffer.lastFlush >= LOG_FLUSH_INTERVAL_MS;

            if (shouldFlush) {
              await flushLogBuffer(logBuffer, {
                apiUrl: opts.apiUrl!,
                apiKey: opts.apiKey || "",
                agentId: opts.agentId || "",
                sessionId: opts.sessionId!,
                iteration: opts.iteration!,
                taskId: opts.taskId,
                cli: "claude",
              });
            }
          }
        }
      }

      // Final flush for remaining buffered logs
      if (shouldStream && logBuffer.lines.length > 0) {
        await flushLogBuffer(logBuffer, {
          apiUrl: opts.apiUrl!,
          apiKey: opts.apiKey || "",
          agentId: opts.agentId || "",
          sessionId: opts.sessionId!,
          iteration: opts.iteration!,
          taskId: opts.taskId,
          cli: "claude",
        });
      }
    }
  })();

  const stderrPromise = (async () => {
    if (proc.stderr) {
      for await (const chunk of proc.stderr) {
        stderrChunks++;
        const text = new TextDecoder().decode(chunk);
        stderrOutput += text;
        prettyPrintStderr(text, role);
        logFileHandle.write(
          `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
        );
      }
    }
  })();

  await Promise.all([stdoutPromise, stderrPromise]);
  await logFileHandle.end();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && stderrOutput) {
    console.error(`\x1b[31m[${role}] Full stderr:\x1b[0m\n${stderrOutput}`);
  }

  if (stdoutChunks === 0 && stderrChunks === 0) {
    console.warn(`\x1b[33m[${role}] WARNING: No output from Claude - check auth/startup\x1b[0m`);
  }

  return exitCode ?? 1;
}

/** Spawn a Claude process without blocking - returns immediately with tracking info */
async function spawnClaudeProcess(
  opts: RunClaudeIterationOptions,
  logDir: string,
  _metadataType: string,
  _sessionId: string,
  isYolo: boolean,
): Promise<RunningTask> {
  const { role, taskId } = opts;
  const Cmd = [
    "claude",
    "--model",
    "opus",
    "--verbose",
    "--output-format",
    "stream-json",
    "--dangerously-skip-permissions",
    "--allow-dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "-p",
    opts.prompt,
  ];

  if (opts.additionalArgs && opts.additionalArgs.length > 0) {
    Cmd.push(...opts.additionalArgs);
  }

  if (opts.systemPrompt) {
    Cmd.push("--append-system-prompt", opts.systemPrompt);
  }

  const effectiveTaskId = taskId || crypto.randomUUID();

  console.log(
    `\x1b[2m[${role}]\x1b[0m \x1b[36m▸\x1b[0m Spawning Claude for task ${effectiveTaskId.slice(0, 8)}`,
  );

  const logFileHandle = Bun.file(opts.logFile).writer();

  // Write task file before spawning so hook can read the current taskId
  // We use the parent process PID since we need to write before spawn
  const taskFilePid = process.pid;
  const taskFilePath = await writeTaskFile(taskFilePid, {
    taskId: effectiveTaskId,
    agentId: opts.agentId || "",
    startedAt: new Date().toISOString(),
  });

  console.log(`\x1b[2m[${role}]\x1b[0m Task file written: ${taskFilePath}`);

  const proc = Bun.spawn(Cmd, {
    env: {
      ...process.env,
      TASK_FILE: taskFilePath,
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Create promise that resolves when process completes
  const promise = (async () => {
    let stderrOutput = "";
    let stdoutChunks = 0;
    let stderrChunks = 0;

    // Initialize log buffer for API streaming
    const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now() };
    const shouldStream = opts.apiUrl && opts.sessionId && opts.iteration;

    const stdoutPromise = (async () => {
      if (proc.stdout) {
        for await (const chunk of proc.stdout) {
          stdoutChunks++;
          const text = new TextDecoder().decode(chunk);
          logFileHandle.write(text);

          const lines = text.split("\n");
          for (const line of lines) {
            prettyPrintLine(line, role);

            // Buffer non-empty lines for API streaming
            if (shouldStream && line.trim()) {
              logBuffer.lines.push(line.trim());

              const shouldFlush =
                logBuffer.lines.length >= LOG_BUFFER_SIZE ||
                Date.now() - logBuffer.lastFlush >= LOG_FLUSH_INTERVAL_MS;

              if (shouldFlush) {
                await flushLogBuffer(logBuffer, {
                  apiUrl: opts.apiUrl!,
                  apiKey: opts.apiKey || "",
                  agentId: opts.agentId || "",
                  sessionId: opts.sessionId!,
                  iteration: opts.iteration!,
                  taskId: opts.taskId,
                  cli: "claude",
                });
              }
            }
          }
        }

        // Final flush for remaining buffered logs
        if (shouldStream && logBuffer.lines.length > 0) {
          await flushLogBuffer(logBuffer, {
            apiUrl: opts.apiUrl!,
            apiKey: opts.apiKey || "",
            agentId: opts.agentId || "",
            sessionId: opts.sessionId!,
            iteration: opts.iteration!,
            taskId: opts.taskId,
            cli: "claude",
          });
        }
      }
    })();

    const stderrPromise = (async () => {
      if (proc.stderr) {
        for await (const chunk of proc.stderr) {
          stderrChunks++;
          const text = new TextDecoder().decode(chunk);
          stderrOutput += text;
          prettyPrintStderr(text, role);
          logFileHandle.write(
            `${JSON.stringify({ type: "stderr", content: text, timestamp: new Date().toISOString() })}\n`,
          );
        }
      }
    })();

    await Promise.all([stdoutPromise, stderrPromise]);
    await logFileHandle.end();
    const exitCode = await proc.exited;

    if (exitCode !== 0 && stderrOutput) {
      console.error(
        `\x1b[31m[${role}] Full stderr for task ${effectiveTaskId.slice(0, 8)}:\x1b[0m\n${stderrOutput}`,
      );
    }

    if (stdoutChunks === 0 && stderrChunks === 0) {
      console.warn(
        `\x1b[33m[${role}] WARNING: No output from Claude for task ${effectiveTaskId.slice(0, 8)} - check auth/startup\x1b[0m`,
      );
    }

    // Log errors if non-zero exit code
    if (exitCode !== 0) {
      const errorLog = {
        timestamp: new Date().toISOString(),
        iteration: opts.iteration,
        exitCode,
        taskId: effectiveTaskId,
        error: true,
      };

      const errorsFile = `${logDir}/errors.jsonl`;
      const errorsFileRef = Bun.file(errorsFile);
      const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
      await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

      if (!isYolo) {
        console.error(
          `[${role}] Task ${effectiveTaskId.slice(0, 8)} exited with code ${exitCode}.`,
        );
      } else {
        console.warn(
          `[${role}] Task ${effectiveTaskId.slice(0, 8)} exited with code ${exitCode}. YOLO mode - continuing...`,
        );
      }
    }

    // Clean up task file after process exits
    await cleanupTaskFile(taskFilePid);
    console.log(`\x1b[2m[${role}]\x1b[0m Task file cleaned up: ${taskFilePath}`);

    return exitCode ?? 1;
  })();

  return {
    taskId: effectiveTaskId,
    process: proc,
    logFile: opts.logFile,
    startTime: new Date(),
    promise,
  };
}

/** Check for completed processes and remove them from active tasks */
async function checkCompletedProcesses(state: RunnerState, role: string): Promise<void> {
  const completedTasks: string[] = [];

  for (const [taskId, task] of state.activeTasks) {
    // Check if the Bun subprocess has exited (non-blocking)
    if (task.process.exitCode !== null) {
      console.log(
        `[${role}] Task ${taskId.slice(0, 8)} completed with exit code ${task.process.exitCode}`,
      );
      completedTasks.push(taskId);
    }
  }

  // Remove completed tasks from the map
  for (const taskId of completedTasks) {
    state.activeTasks.delete(taskId);
  }
}

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const { role, defaultPrompt, metadataType } = config;

  const sessionId = process.env.SESSION_ID || crypto.randomUUID().slice(0, 8);
  const baseLogDir = opts.logsDir || process.env.LOG_DIR || "/logs";
  const logDir = `${baseLogDir}/${sessionId}`;

  await mkdir(logDir, { recursive: true });

  const prompt = opts.prompt || defaultPrompt;
  const isYolo = opts.yolo || process.env.YOLO === "true";

  // Get agent identity and swarm URL for base prompt
  const agentId = process.env.AGENT_ID || "unknown";

  const apiUrl = process.env.MCP_BASE_URL || "http://localhost:3013";
  const swarmUrl = process.env.SWARM_URL || "localhost";

  const capabilities = config.capabilities;

  // Generate base prompt that's always included
  const basePrompt = getBasePrompt({ role, agentId, swarmUrl, capabilities });

  // Resolve additional system prompt: CLI flag > env var
  let additionalSystemPrompt: string | undefined;
  const systemPromptText = opts.systemPrompt || process.env.SYSTEM_PROMPT;
  const systemPromptFilePath = opts.systemPromptFile || process.env.SYSTEM_PROMPT_FILE;

  if (systemPromptText) {
    additionalSystemPrompt = systemPromptText;
    console.log(
      `[${role}] Using additional system prompt from ${opts.systemPrompt ? "CLI flag" : "env var"}`,
    );
  } else if (systemPromptFilePath) {
    try {
      const file = Bun.file(systemPromptFilePath);
      if (!(await file.exists())) {
        console.error(`[${role}] ERROR: System prompt file not found: ${systemPromptFilePath}`);
        process.exit(1);
      }
      additionalSystemPrompt = await file.text();
      console.log(`[${role}] Loaded additional system prompt from file: ${systemPromptFilePath}`);
      console.log(
        `[${role}] Additional system prompt length: ${additionalSystemPrompt.length} characters`,
      );
    } catch (error) {
      console.error(`[${role}] ERROR: Failed to read system prompt file: ${systemPromptFilePath}`);
      console.error(error);
      process.exit(1);
    }
  }

  // Combine base prompt with any additional system prompt
  const resolvedSystemPrompt = additionalSystemPrompt
    ? `${basePrompt}\n\n${additionalSystemPrompt}`
    : basePrompt;

  console.log(`[${role}] Starting ${role}`);
  console.log(`[${role}] Agent ID: ${agentId}`);
  console.log(`[${role}] Session ID: ${sessionId}`);
  console.log(`[${role}] Log directory: ${logDir}`);
  console.log(`[${role}] YOLO mode: ${isYolo ? "enabled" : "disabled"}`);
  console.log(`[${role}] Prompt: ${prompt}`);
  console.log(`[${role}] API URL: ${apiUrl}`);
  console.log(`[${role}] Swarm URL: ${apiUrl}`);
  console.log(`[${role}] Base prompt: included (${basePrompt.length} chars)`);
  console.log(
    `[${role}] Additional system prompt: ${additionalSystemPrompt ? "provided" : "none"}`,
  );
  console.log(`[${role}] Total system prompt length: ${resolvedSystemPrompt.length} chars`);

  const isAiLoop = opts.aiLoop || process.env.AI_LOOP === "true";
  const apiKey = process.env.API_KEY || "";

  // Constants for polling
  const PollIntervalMs = 2000; // 2 seconds between polls
  const PollTimeoutMs = 60000; // 1 minute timeout before retrying

  let iteration = 0;

  if (!isAiLoop) {
    // Runner-level polling mode with parallel execution support
    const maxConcurrent = parseInt(process.env.MAX_CONCURRENT_TASKS || "1", 10);
    console.log(`[${role}] Mode: runner-level polling (use --ai-loop for AI-based polling)`);
    console.log(`[${role}] Max concurrent tasks: ${maxConcurrent}`);

    // Initialize runner state for parallel execution
    const state: RunnerState = {
      activeTasks: new Map(),
      maxConcurrent,
    };

    // Create API config for ping/close
    const apiConfig: ApiConfig = { apiUrl, apiKey, agentId };

    // Setup graceful shutdown handlers with API config and runner state access
    setupShutdownHandlers(role, apiConfig, () => state);

    // Register agent before starting
    const agentName = process.env.AGENT_NAME || `${role}-${agentId.slice(0, 8)}`;
    try {
      await registerAgent({
        apiUrl,
        apiKey,
        agentId,
        name: agentName,
        isLead: role === "lead",
        capabilities: config.capabilities,
        maxTasks: maxConcurrent,
      });
      console.log(`[${role}] Registered as "${agentName}" (ID: ${agentId})`);
    } catch (error) {
      console.error(`[${role}] Failed to register: ${error}`);
      process.exit(1);
    }

    // Track last finished task check for leads (to avoid re-processing)
    let lastFinishedTaskCheck: string | undefined;

    while (true) {
      // Ping server on each iteration to keep status updated
      await pingServer(apiConfig, role);

      // Check for completed processes first
      await checkCompletedProcesses(state, role);

      // Only poll if we have capacity
      if (state.activeTasks.size < state.maxConcurrent) {
        console.log(
          `[${role}] Polling for triggers (${state.activeTasks.size}/${state.maxConcurrent} active)...`,
        );

        // Use shorter timeout if tasks are running (to check completion more often)
        const effectiveTimeout = state.activeTasks.size > 0 ? 5000 : PollTimeoutMs;

        const trigger = await pollForTrigger({
          apiUrl,
          apiKey,
          agentId,
          pollInterval: PollIntervalMs,
          pollTimeout: effectiveTimeout,
          since: lastFinishedTaskCheck,
        });

        if (trigger) {
          // After getting a tasks_finished trigger, update the timestamp
          if (trigger.type === "tasks_finished") {
            lastFinishedTaskCheck = new Date().toISOString();
          }

          console.log(`[${role}] Trigger received: ${trigger.type}`);

          // Build prompt based on trigger
          const triggerPrompt = buildPromptForTrigger(trigger, prompt);

          iteration++;
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const taskIdSlice = trigger.taskId?.slice(0, 8) || "notask";
          const logFile = `${logDir}/${timestamp}-${taskIdSlice}.jsonl`;

          console.log(`\n[${role}] === Iteration ${iteration} ===`);
          console.log(`[${role}] Logging to: ${logFile}`);
          console.log(`[${role}] Prompt: ${triggerPrompt.slice(0, 100)}...`);

          const metadata = {
            type: metadataType,
            sessionId,
            iteration,
            timestamp: new Date().toISOString(),
            prompt: triggerPrompt,
            trigger: trigger.type,
            yolo: isYolo,
          };
          await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

          // Spawn without blocking (await to write task file, but process runs async)
          const runningTask = await spawnClaudeProcess(
            {
              prompt: triggerPrompt,
              logFile,
              systemPrompt: resolvedSystemPrompt,
              additionalArgs: opts.additionalArgs,
              role,
              apiUrl,
              apiKey,
              agentId,
              sessionId,
              iteration,
              taskId: trigger.taskId,
            },
            logDir,
            metadataType,
            sessionId,
            isYolo,
          );

          state.activeTasks.set(runningTask.taskId, runningTask);
          console.log(
            `[${role}] Started task ${runningTask.taskId.slice(0, 8)} (${state.activeTasks.size}/${state.maxConcurrent} active)`,
          );
        }
      } else {
        console.log(
          `[${role}] At capacity (${state.activeTasks.size}/${state.maxConcurrent}), waiting for completion...`,
        );
        await Bun.sleep(1000);
      }
    }
  } else {
    // Original AI-loop mode (existing behavior)
    console.log(`[${role}] Mode: AI-based polling (legacy)`);

    // Create API config for ping/close
    const apiConfig: ApiConfig = { apiUrl, apiKey, agentId };

    // Setup graceful shutdown handlers with API config for close on exit
    setupShutdownHandlers(role, apiConfig);

    while (true) {
      // Ping server on each iteration to keep status updated
      await pingServer(apiConfig, role);

      iteration++;
      const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
      const logFile = `${logDir}/${timestamp}.jsonl`;

      console.log(`\n[${role}] === Iteration ${iteration} ===`);
      console.log(`[${role}] Logging to: ${logFile}`);

      const metadata = {
        type: metadataType,
        sessionId,
        iteration,
        timestamp: new Date().toISOString(),
        prompt,
        yolo: isYolo,
      };
      await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

      const exitCode = await runClaudeIteration({
        prompt,
        logFile,
        systemPrompt: resolvedSystemPrompt,
        additionalArgs: opts.additionalArgs,
        role,
      });

      if (exitCode !== 0) {
        const errorLog = {
          timestamp: new Date().toISOString(),
          iteration,
          exitCode,
          error: true,
        };

        const errorsFile = `${logDir}/errors.jsonl`;
        const errorsFileRef = Bun.file(errorsFile);
        const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
        await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

        if (!isYolo) {
          console.error(`[${role}] Claude exited with code ${exitCode}. Stopping.`);
          console.error(`[${role}] Error logged to: ${errorsFile}`);
          process.exit(exitCode);
        }

        console.warn(`[${role}] Claude exited with code ${exitCode}. YOLO mode - continuing...`);
      }

      console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
    }
  }
}
