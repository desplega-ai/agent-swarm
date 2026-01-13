import { mkdir } from "node:fs/promises";
import { getTaskById, updateRalphState } from "../be/db";
import { getBasePrompt } from "../prompts/base-prompt.ts";
import { clearCheckpoint, readCheckpoint } from "../ralph/state";
import type { AgentTask } from "../types";
import { prettyPrintLine, prettyPrintStderr } from "../utils/pretty-print.ts";

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
    case "task_assigned":
      // Use the work-on-task command with task ID
      return `/work-on-task Start working on task with ID ${trigger.taskId}`;

    case "task_offered":
      // Use the review-offered-task command to accept/reject
      return `/review-offered-task Review task with ID ${trigger.taskId} and either accept or reject it.`;

    case "unread_mentions":
      // Check messages
      return "You have unread messages in the chat. Use /swarm-chat to review them, respond to them if applicable and start working on any new tasks if needed based on the messages (you might need to create new tasks).";

    case "pool_tasks_available":
      // Worker: claim a task from the pool
      // Include the count so worker knows there are tasks available
      return `There are ${trigger.count} unassigned task(s) available in the pool. Use get-tasks with unassigned: true to see them, then use task-action with action: "claim" to claim one. The claim is first-come-first-serve, so if your claim fails, try another task.`;

    case "tasks_finished":
      // Lead: simple notification about finished tasks
      if (trigger.tasks && Array.isArray(trigger.tasks) && trigger.tasks.length > 0) {
        const taskSummaries = trigger.tasks
          .map((t) => {
            const status = t.status === "completed" ? "completed" : "failed";
            const agentName = t.agentId ? `Agent ${t.agentId.slice(0, 8)}` : "Unknown agent";
            return `- ${agentName} ${status} task "${t.task?.slice(0, 50)}..." (ID: ${t.id})`;
          })
          .join("\n");

        return `Workers have finished ${trigger.count} task(s):\n${taskSummaries}\n\nReview these results and decide if any follow-up actions are needed.`;
      }

      return `Workers have finished ${trigger.count} task(s). Use get-tasks with status "completed" or "failed" to review them.`;

    case "slack_inbox_message": {
      // Lead: Slack inbox messages from users
      const inboxSummaries = (trigger.messages || [])
        .map((m: { id: string; content: string }) => {
          const preview = m.content.length > 100 ? `${m.content.slice(0, 100)}...` : m.content;
          return `- "${preview}" (inboxMessageId: ${m.id})`;
        })
        .join("\n");

      return `You have ${trigger.count} inbox message(s) from Slack:\n${inboxSummaries}\n\nFor each message, you can either:
- Use \`slack-reply\` with the inboxMessageId to respond directly to the user
- Use \`inbox-delegate\` to assign the request to a worker agent

Review each message and decide the appropriate action.`;
    }

    default:
      return defaultPrompt;
  }
}

/** Check if a task is a Ralph iterative task */
function isRalphTask(task: { taskType?: string }): boolean {
  return task.taskType === "ralph";
}

/** Build a Ralph-specific iteration prompt */
function buildRalphIterationPrompt(task: AgentTask, iteration: number): string {
  const basePrompt = `/work-on-task Start working on task with ID ${task.id}`;

  const context = `

## Ralph Iteration Context

This is iteration ${iteration + 1} of a Ralph iterative task.
${iteration > 0 ? `Previous iterations: ${iteration}` : "This is the first iteration."}

**Completion Promise**: ${task.ralphPromise || "Not specified"}
${task.ralphPlanPath ? `**Plan File**: ${task.ralphPlanPath}` : ""}

Your context has been reset, but all files and code persist.
- Read the plan file or progress notes to understand current state
- Continue from where the previous iteration left off
- When the completion promise is met, call \`ralph-complete\` to finish

If the task cannot be completed in this iteration, simply work as far as you can.
The context will reset and you'll continue in the next iteration.`;

  return basePrompt + context;
}

/** Options for running a Ralph iterative loop */
interface RalphLoopOptions {
  task: AgentTask;
  role: string;
  logDir: string;
  sessionId: string;
  resolvedSystemPrompt: string;
  additionalArgs?: string[];
  apiUrl: string;
  apiKey: string;
  agentId: string;
  isYolo: boolean;
  metadataType: string;
}

/** Run a Ralph iterative task loop */
async function runRalphLoop(opts: RalphLoopOptions): Promise<void> {
  const {
    task,
    role,
    logDir,
    sessionId,
    resolvedSystemPrompt,
    additionalArgs,
    apiUrl,
    apiKey,
    agentId,
    isYolo,
    metadataType,
  } = opts;

  console.log(`[${role}] Starting Ralph loop for task ${task.id.slice(0, 8)}`);
  console.log(`[${role}] Promise: "${task.ralphPromise || "Not specified"}"`);
  console.log(`[${role}] Max iterations: ${task.ralphMaxIterations || 50}`);

  // Clear any stale checkpoint from previous run
  await clearCheckpoint(task.id);

  let currentIteration = task.ralphIterations || 0;
  const maxIterations = task.ralphMaxIterations || 50;

  while (currentIteration < maxIterations) {
    console.log(`\n[${role}] === Ralph Iteration ${currentIteration + 1}/${maxIterations} ===`);

    // Update task iteration count in database
    updateRalphState(task.id, { iterations: currentIteration + 1 });

    // Build iteration-specific prompt
    const iterationPrompt = buildRalphIterationPrompt(task, currentIteration);

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const logFile = `${logDir}/${timestamp}-ralph-${task.id.slice(0, 8)}-iter${currentIteration + 1}.jsonl`;

    console.log(`[${role}] Logging to: ${logFile}`);

    const metadata = {
      type: metadataType,
      sessionId,
      iteration: currentIteration + 1,
      timestamp: new Date().toISOString(),
      prompt: `${iterationPrompt.slice(0, 200)}...`,
      trigger: "ralph_iteration",
      taskId: task.id,
      ralphIteration: currentIteration + 1,
      yolo: isYolo,
    };
    await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

    // Run Claude iteration (blocking)
    const exitCode = await runClaudeIteration({
      prompt: iterationPrompt,
      logFile,
      systemPrompt: resolvedSystemPrompt,
      additionalArgs,
      role,
      apiUrl,
      apiKey,
      agentId,
      sessionId,
      iteration: currentIteration + 1,
      taskId: task.id,
    });

    console.log(
      `[${role}] Ralph iteration ${currentIteration + 1} completed with exit code ${exitCode}`,
    );

    // Check if task was completed (ralph-complete called)
    const refreshedTask = getTaskById(task.id);
    if (
      !refreshedTask ||
      refreshedTask.status === "completed" ||
      refreshedTask.status === "failed"
    ) {
      console.log(
        `[${role}] Ralph task ${task.id.slice(0, 8)} finished with status: ${refreshedTask?.status || "unknown"}`,
      );
      await clearCheckpoint(task.id);
      return;
    }

    // Check for checkpoint (context was full or session ended)
    const checkpoint = await readCheckpoint(task.id);
    if (checkpoint) {
      console.log(`[${role}] Checkpoint detected: ${checkpoint.checkpointReason}`);

      if (checkpoint.checkpointReason === "manual") {
        // Task was completed via ralph-complete
        console.log(`[${role}] Ralph task completed via ralph-complete`);
        await clearCheckpoint(task.id);
        return;
      }

      // Context was full, continue to next iteration
      console.log(`[${role}] Context full, starting next iteration...`);
      await clearCheckpoint(task.id);
      currentIteration++;

      // Update checkpoint timestamp
      updateRalphState(task.id, {
        lastCheckpoint: new Date().toISOString(),
        iterations: currentIteration,
      });

      // Small delay before next iteration
      await Bun.sleep(2000);
    } else if (exitCode !== 0 && !isYolo) {
      console.error(`[${role}] Ralph iteration failed with exit code ${exitCode}. Stopping loop.`);
      return;
    } else {
      // No checkpoint and successful exit - unusual, check task status again
      const finalTask = getTaskById(task.id);
      if (finalTask?.status === "completed" || finalTask?.status === "failed") {
        console.log(`[${role}] Ralph task finished during iteration`);
        return;
      }

      // Continue anyway in case agent forgot to checkpoint
      console.log(`[${role}] No checkpoint but task still in progress. Continuing...`);
      currentIteration++;
      await Bun.sleep(2000);
    }
  }

  console.log(
    `[${role}] Ralph task ${task.id.slice(0, 8)} reached max iterations (${maxIterations})`,
  );
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
function spawnClaudeProcess(
  opts: RunClaudeIterationOptions,
  logDir: string,
  _metadataType: string,
  _sessionId: string,
  isYolo: boolean,
): RunningTask {
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

  const proc = Bun.spawn(Cmd, {
    env: process.env,
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

          // Check if this is a Ralph task that needs special handling
          if (trigger.type === "task_assigned" && trigger.taskId && trigger.task) {
            // Fetch full task details to check if it's a Ralph task
            const fullTask = getTaskById(trigger.taskId);
            if (fullTask && isRalphTask(fullTask)) {
              console.log(
                `[${role}] Detected Ralph task ${trigger.taskId.slice(0, 8)}, starting Ralph loop...`,
              );

              // Run Ralph loop (this is blocking but handles its own iterations)
              // We run it as a separate async task so we don't block the main loop
              const ralphPromise = runRalphLoop({
                task: fullTask,
                logDir,
                resolvedSystemPrompt,
                additionalArgs: opts.additionalArgs,
                role,
                apiUrl,
                apiKey,
                agentId,
                sessionId,
                isYolo,
                metadataType,
              });

              // Track Ralph task in state
              const ralphTaskState = {
                taskId: fullTask.id,
                process: null as unknown as ReturnType<typeof Bun.spawn>,
                logFile: `${logDir}/ralph-${fullTask.id.slice(0, 8)}.log`,
                startTime: new Date(),
                promise: ralphPromise as unknown as Promise<number>,
              };
              state.activeTasks.set(fullTask.id, ralphTaskState);
              console.log(
                `[${role}] Started Ralph task ${fullTask.id.slice(0, 8)} (${state.activeTasks.size}/${state.maxConcurrent} active)`,
              );

              // Don't await here - let it run in background
              ralphPromise
                .then(() => {
                  console.log(`[${role}] Ralph task ${fullTask.id.slice(0, 8)} completed`);
                  state.activeTasks.delete(fullTask.id);
                })
                .catch((err) => {
                  console.error(`[${role}] Ralph task ${fullTask.id.slice(0, 8)} failed:`, err);
                  state.activeTasks.delete(fullTask.id);
                });

              continue; // Skip normal task processing
            }
          }

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

          // Spawn without blocking
          const runningTask = spawnClaudeProcess(
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
