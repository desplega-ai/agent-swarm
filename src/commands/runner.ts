import { mkdir, unlink, writeFile } from "node:fs/promises";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  generateDefaultSoulMd,
  generateDefaultToolsMd,
} from "../be/db.ts";
import { type BasePromptArgs, getBasePrompt } from "../prompts/base-prompt.ts";
import {
  parseStderrForErrors,
  SessionErrorTracker,
  trackErrorFromJson,
} from "../utils/error-tracker.ts";
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

/** Fetch repo config for a task's githubRepo (e.g., "desplega-ai/agent-swarm") */
async function fetchRepoConfig(
  apiUrl: string,
  apiKey: string,
  githubRepo: string,
): Promise<{ url: string; name: string; clonePath: string; defaultBranch: string } | null> {
  try {
    const repoName = githubRepo.split("/").pop() || githubRepo;
    const resp = await fetch(`${apiUrl}/api/repos?name=${encodeURIComponent(repoName)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      repos: Array<{ url: string; name: string; clonePath: string; defaultBranch: string }>;
    };
    return data.repos.find((r) => r.url.includes(githubRepo)) ?? data.repos[0] ?? null;
  } catch {
    return null;
  }
}

function isGitHubRepo(url: string): boolean {
  return url.includes("github.com") || /^[\w.-]+\/[\w.-]+$/.test(url);
}

/** Read CLAUDE.md from a repo directory, returning null if not found */
async function readClaudeMd(clonePath: string, role: string): Promise<string | null> {
  const claudeMdFile = Bun.file(`${clonePath}/CLAUDE.md`);
  if (await claudeMdFile.exists()) {
    const content = await claudeMdFile.text();
    console.log(`[${role}] Read CLAUDE.md from ${clonePath}/CLAUDE.md (${content.length} chars)`);
    return content;
  }
  console.log(`[${role}] No CLAUDE.md found at ${clonePath}/CLAUDE.md`);
  return null;
}

/**
 * Ensure a repo is cloned and up-to-date for a task.
 * Returns { clonePath, claudeMd, warning }.
 */
async function ensureRepoForTask(
  repoConfig: { url: string; name: string; clonePath: string; defaultBranch: string },
  role: string,
): Promise<{ clonePath: string; claudeMd: string | null; warning: string | null }> {
  const { url, name, clonePath, defaultBranch } = repoConfig;

  try {
    const gitHeadExists = await Bun.file(`${clonePath}/.git/HEAD`).exists();

    let warning: string | null = null;

    if (!gitHeadExists) {
      console.log(`[${role}] Cloning ${name} to ${clonePath}...`);
      if (isGitHubRepo(url)) {
        await Bun.$`gh repo clone ${url} ${clonePath} -- --branch ${defaultBranch} --single-branch`.quiet();
      } else {
        await Bun.$`git clone --branch ${defaultBranch} --single-branch ${url} ${clonePath}`.quiet();
      }
      console.log(`[${role}] Cloned ${name}`);
    } else {
      console.log(`[${role}] Repo ${name} already cloned at ${clonePath}`);
      const statusResult = await Bun.$`cd ${clonePath} && git status --porcelain`.quiet();
      const statusOutput = statusResult.text().trim();

      if (statusOutput === "") {
        console.log(`[${role}] Pulling ${name} (${defaultBranch})...`);
        await Bun.$`cd ${clonePath} && git pull origin ${defaultBranch} --ff-only`.quiet();
        console.log(`[${role}] Pulled ${name}`);
      } else {
        console.warn(`[${role}] Repo ${name} has uncommitted changes, skipping pull`);
        warning = `The repo "${name}" at ${clonePath} has uncommitted changes. A git pull was skipped to avoid losing work. You may need to commit or stash changes before pulling updates.`;
      }
    }

    const claudeMd = await readClaudeMd(clonePath, role);
    return { clonePath, claudeMd, warning };
  } catch (err) {
    const errorMsg = (err as Error).message;
    console.warn(`[${role}] Error setting up repo ${name}: ${errorMsg}`);
    const warning = `Failed to clone/setup repo "${name}" at ${clonePath}: ${errorMsg}. The repo may not be available. You may need to clone it manually.`;
    return { clonePath, claudeMd: null, warning };
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

/**
 * Fetch resolved config from the API and merge into a base env object.
 * Falls back to baseEnv on any error (network, parse, etc).
 */
async function fetchResolvedEnv(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Promise<Record<string, string | undefined>> {
  if (!apiUrl || !agentId) return { ...baseEnv };

  try {
    const headers: Record<string, string> = { "X-Agent-ID": agentId };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const url = `${apiUrl}/api/config/resolved?agentId=${encodeURIComponent(agentId)}&includeSecrets=true`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      console.warn(`[env-reload] Failed to fetch config: ${response.status}`);
      return { ...baseEnv };
    }

    const data = (await response.json()) as {
      configs: Array<{ key: string; value: string }>;
    };

    if (!data.configs?.length) return { ...baseEnv };

    const merged: Record<string, string | undefined> = { ...baseEnv };
    for (const config of data.configs) {
      merged[config.key] = config.value;
    }

    console.log(`[env-reload] Loaded ${data.configs.length} config entries from API`);
    return merged;
  } catch (error) {
    console.warn(`[env-reload] Could not fetch config, using current env: ${error}`);
    return { ...baseEnv };
  }
}

/**
 * Ensure task is marked as completed or failed via the API.
 * This is called when a Claude process exits to ensure task status is updated,
 * regardless of whether the agent explicitly called store-progress.
 *
 * The API is idempotent - if the agent already marked the task as completed/failed,
 * this call will succeed without changing anything.
 */
async function ensureTaskFinished(
  config: ApiConfig,
  role: string,
  taskId: string,
  exitCode: number,
  failureReason?: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  // Determine status and reason based on exit code
  // Exit code 0 = success, non-zero = failure
  const status = exitCode === 0 ? "completed" : "failed";
  const body: Record<string, string> = { status };

  if (status === "failed") {
    body.failureReason = failureReason || `Claude process exited with code ${exitCode}`;
  } else {
    body.output =
      "Process completed (runner wrapper fallback - agent may have provided explicit output)";
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/finish`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (response.ok) {
      const result = (await response.json()) as {
        alreadyFinished?: boolean;
        task?: { status?: string };
      };
      if (result.alreadyFinished) {
        console.log(
          `[${role}] Task ${taskId.slice(0, 8)} was already marked as ${result.task?.status || "finished"}`,
        );
      } else {
        console.log(
          `[${role}] Runner marked task ${taskId.slice(0, 8)} as ${status} (exit code: ${exitCode})`,
        );
      }
    } else if (response.status === 404) {
      console.log(`[${role}] Task ${taskId.slice(0, 8)} already finalized (not found), skipping`);
    } else {
      const error = await response.text();
      console.warn(
        `[${role}] Failed to finish task ${taskId.slice(0, 8)}: ${response.status} ${error}`,
      );
    }
  } catch (err) {
    console.warn(`[${role}] Error finishing task ${taskId.slice(0, 8)}: ${err}`);
  }
}

/**
 * Reset task notifications via the API.
 * Called when a tasks_finished trigger was consumed but the Claude session failed.
 * Resets notifiedAt to NULL so the tasks will be re-delivered on the next poll.
 */
async function resetTaskNotifications(
  config: ApiConfig,
  role: string,
  taskIds: string[],
  exitCode: number,
): Promise<void> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/reset-notification`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        taskIds,
        reason: `Claude session exited with code ${exitCode}`,
      }),
    });

    if (response.ok) {
      const result = (await response.json()) as { resetCount: number };
      console.log(
        `[${role}] Reset notifications for ${result.resetCount}/${taskIds.length} task(s) — they will be re-delivered on next poll`,
      );
    } else {
      const error = await response.text();
      console.warn(`[${role}] Failed to reset notifications: ${response.status} ${error}`);
    }
  } catch (err) {
    console.warn(`[${role}] Error resetting notifications: ${err}`);
  }
}

/**
 * Pause a task via the API (for graceful shutdown).
 * Unlike marking as failed, paused tasks can be resumed after container restart.
 */
async function pauseTaskViaAPI(config: ApiConfig, role: string, taskId: string): Promise<boolean> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/pause`, {
      method: "POST",
      headers,
    });

    if (response.ok) {
      console.log(`[${role}] Task ${taskId.slice(0, 8)} paused for graceful shutdown`);
      return true;
    } else {
      const error = await response.text();
      console.warn(
        `[${role}] Failed to pause task ${taskId.slice(0, 8)}: ${response.status} ${error}`,
      );
      return false;
    }
  } catch (err) {
    console.warn(`[${role}] Error pausing task ${taskId.slice(0, 8)}: ${err}`);
    return false;
  }
}

/** Fetch paused tasks from API for this agent */
async function getPausedTasksFromAPI(config: ApiConfig): Promise<
  Array<{
    id: string;
    task: string;
    progress?: string;
    claudeSessionId?: string;
    parentTaskId?: string;
  }>
> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/paused-tasks`, {
      method: "GET",
      headers,
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to fetch paused tasks: ${response.status}`);
      return [];
    }

    const data = (await response.json()) as {
      tasks: Array<{
        id: string;
        task: string;
        progress?: string;
        claudeSessionId?: string;
        parentTaskId?: string;
      }>;
    };
    return data.tasks || [];
  } catch (error) {
    console.warn(`[runner] Error fetching paused tasks: ${error}`);
    return [];
  }
}

/** Resume a task via API (marks as in_progress) */
async function resumeTaskViaAPI(config: ApiConfig, taskId: string): Promise<boolean> {
  const headers: Record<string, string> = {
    "X-Agent-ID": config.agentId,
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    const response = await fetch(`${config.apiUrl}/api/tasks/${taskId}/resume`, {
      method: "POST",
      headers,
    });

    return response.ok;
  } catch {
    return false;
  }
}

/** Build prompt for a resumed task */
function buildResumePrompt(task: { id: string; task: string; progress?: string }): string {
  let prompt = `/work-on-task ${task.id}

**RESUMED TASK** - This task was interrupted during a deployment and is being resumed.

Task: "${task.task}"`;

  if (task.progress) {
    prompt += `

Previous Progress:
${task.progress}

Continue from where you left off. Review the progress above and complete the remaining work.`;
  } else {
    prompt += `

No progress was saved before the interruption. Start the task fresh but be aware files may have been partially modified.`;
  }

  prompt += `

When done, use \`store-progress\` with status: "completed" and include your output.`;

  return prompt;
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
        await checkCompletedProcesses(state, role, apiConfig);
        if (state.activeTasks.size > 0) {
          await Bun.sleep(500);
        }
      }

      // Force kill remaining tasks and mark them as paused (for graceful resume after restart)
      if (state.activeTasks.size > 0) {
        console.log(
          `[${role}] Pausing ${state.activeTasks.size} remaining task(s) for resume after restart...`,
        );
        for (const [taskId, task] of state.activeTasks) {
          console.log(`[${role}] Pausing task ${taskId.slice(0, 8)}`);
          task.process.kill("SIGTERM");
          // Mark as paused for graceful resume (instead of failed)
          if (apiConfig) {
            const paused = await pauseTaskViaAPI(apiConfig, role, taskId);
            if (!paused) {
              // Fallback to marking as failed if pause fails
              console.warn(
                `[${role}] Failed to pause task ${taskId.slice(0, 8)}, marking as failed instead`,
              );
              await ensureTaskFinished(apiConfig, role, taskId, 1);
            }
          }
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
  promise: Promise<{ exitCode: number; errorTracker: SessionErrorTracker }>;
  /** The trigger type that caused this task to be spawned */
  triggerType?: string;
  /** For tasks_finished triggers: the IDs of finished worker tasks that were notified.
   *  Used to reset notifiedAt if the session fails (prevents notification loss). */
  notifiedTaskIds?: string[];
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
  partialLine: string; // Accumulates incomplete line across chunks
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

/** Data for session cost tracking */
interface CostData {
  sessionId: string;
  taskId?: string;
  agentId: string;
  totalCostUsd: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  durationMs: number;
  numTurns: number;
  model: string;
  isError: boolean;
}

/** Save session cost data to the API */
async function saveCostData(cost: CostData, apiUrl: string, apiKey: string): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": cost.agentId,
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  try {
    const response = await fetch(`${apiUrl}/api/session-costs`, {
      method: "POST",
      headers,
      body: JSON.stringify(cost),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to save cost data: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error saving cost data: ${error}`);
  }
}

/** Save Claude session ID for a task (fire-and-forget) */
async function saveClaudeSessionId(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  claudeSessionId: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  await fetch(`${apiUrl}/api/tasks/${taskId}/claude-session`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ claudeSessionId }),
  });
}

/** Fetch Claude session ID for a task (for --resume) */
async function fetchClaudeSessionId(
  apiUrl: string,
  apiKey: string,
  taskId: string,
): Promise<string | null> {
  const headers: Record<string, string> = {};
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  try {
    const response = await fetch(`${apiUrl}/api/tasks/${taskId}`, { headers });
    if (!response.ok) return null;
    const data = (await response.json()) as { claudeSessionId?: string };
    return data.claudeSessionId || null;
  } catch {
    return null;
  }
}

/** Trigger types returned by the poll API */
interface Trigger {
  type:
    | "task_assigned"
    | "task_offered"
    | "unread_mentions"
    | "pool_tasks_available"
    | "tasks_finished"
    | "slack_inbox_message"
    | "epic_progress_changed";
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
  epics?: unknown; // Epic progress updates for lead
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

    case "epic_progress_changed": {
      // Lead: Epic progress updated - tasks completed or failed for an active epic
      // This is similar to ralph loop - keep the epic progressing until done
      const epics = trigger.epics as Array<{
        epic: {
          id: string;
          name: string;
          goal: string;
          status: string;
          progress: number;
          taskStats: {
            total: number;
            completed: number;
            failed: number;
            inProgress: number;
            pending: number;
          };
        };
        finishedTasks: Array<{
          id: string;
          task: string;
          status: string;
          output?: string;
          failureReason?: string;
          agentId?: string;
        }>;
      }>;

      if (!epics || epics.length === 0) {
        return "Epic progress was updated but no details available. Use `list-epics` to check status.";
      }

      let prompt = `## Epic Progress Update\n\n${trigger.count} epic(s) have progress updates:\n\n`;

      for (const { epic, finishedTasks } of epics) {
        prompt += `### Epic: "${epic.name}" (${epic.id.slice(0, 8)})\n`;
        prompt += `**Goal:** ${epic.goal}\n`;
        prompt += `**Progress:** ${epic.progress}% complete (${epic.taskStats.completed}/${epic.taskStats.total} tasks)\n`;
        prompt += `**Status:** ${epic.status}\n\n`;

        // Show finished tasks
        const completed = finishedTasks.filter((t) => t.status === "completed");
        const failed = finishedTasks.filter((t) => t.status === "failed");

        if (completed.length > 0) {
          prompt += "**Recently Completed:**\n";
          for (const t of completed) {
            const agentName = t.agentId ? `Agent ${t.agentId.slice(0, 8)}` : "Unknown";
            const output = t.output ? t.output.slice(0, 150) : "(no output)";
            prompt += `- Task ${t.id.slice(0, 8)} by ${agentName}: "${t.task.slice(0, 80)}"\n`;
            prompt += `  Output: ${output}${t.output && t.output.length > 150 ? "..." : ""}\n`;
          }
        }

        if (failed.length > 0) {
          prompt += "\n**Recently Failed:**\n";
          for (const t of failed) {
            const agentName = t.agentId ? `Agent ${t.agentId.slice(0, 8)}` : "Unknown";
            prompt += `- Task ${t.id.slice(0, 8)} by ${agentName}: "${t.task.slice(0, 80)}"\n`;
            prompt += `  Reason: ${t.failureReason || "(no reason)"}\n`;
          }
        }

        // Show remaining work
        const { inProgress, pending } = epic.taskStats;
        if (inProgress > 0 || pending > 0) {
          prompt += `\n**Remaining:** ${inProgress} in progress, ${pending} pending\n`;
        }

        prompt += "\n---\n\n";
      }

      prompt += `## Your Task: Plan Next Steps

For each epic:
1. **Review** the completed work and any failures
2. **Determine** if the epic goal is met (progress = 100% and all tasks succeeded)
3. **If complete:** Use \`update-epic\` to mark status as "completed"
4. **If not complete:**
   - Retry failed tasks with \`send-task\` (reassign or modify)
   - Create new tasks for remaining work with \`send-task\` (include epicId)
   - Keep the epic progressing until the goal is achieved

This is an iterative process - you'll be notified again when more tasks finish.
The epic should keep progressing until 100% complete and the goal is achieved.`;

      return prompt;
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

async function runClaudeIteration(
  opts: RunClaudeIterationOptions,
): Promise<{ exitCode: number; errorTracker: SessionErrorTracker }> {
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

  const freshEnv = await fetchResolvedEnv(opts.apiUrl || "", opts.apiKey || "", opts.agentId || "");

  const proc = Bun.spawn(Cmd, {
    env: freshEnv,
    stdout: "pipe",
    stderr: "pipe",
  });

  let stdoutChunks = 0;
  let stderrChunks = 0;

  // Track error signals from Claude CLI output for meaningful failure reasons
  const errorTracker = new SessionErrorTracker();

  const stdoutPromise = (async () => {
    if (proc.stdout) {
      // Initialize log buffer for API streaming
      const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now(), partialLine: "" };
      const shouldStream = opts.apiUrl && opts.sessionId && opts.iteration;

      for await (const chunk of proc.stdout) {
        stdoutChunks++;
        const text = new TextDecoder().decode(chunk);
        logFileHandle.write(text);

        // Prepend any partial line from previous chunk
        const combined = logBuffer.partialLine + text;
        const parts = combined.split("\n");

        // Last element may be incomplete - save for next chunk
        logBuffer.partialLine = parts.pop() || "";

        // Process only complete lines (those that ended with \n)
        for (const line of parts) {
          prettyPrintLine(line, role);

          // Buffer non-empty lines for API streaming
          if (shouldStream && line.trim()) {
            // Capture Claude session ID from init message (legacy mode)
            try {
              const json = JSON.parse(line.trim());
              if (json.type === "system" && json.subtype === "init" && json.session_id) {
                if (opts.taskId) {
                  saveClaudeSessionId(
                    opts.apiUrl || "",
                    opts.apiKey || "",
                    opts.taskId,
                    json.session_id,
                  ).catch((err) => console.warn(`[runner] Failed to save session ID: ${err}`));
                }
              }
              trackErrorFromJson(json, errorTracker);
            } catch {
              // Not JSON - ignore
            }

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

      // Handle any remaining partial line at stream end
      if (logBuffer.partialLine.trim()) {
        prettyPrintLine(logBuffer.partialLine, role);
        if (shouldStream) {
          try {
            const json = JSON.parse(logBuffer.partialLine.trim());
            trackErrorFromJson(json, errorTracker);
          } catch {
            // Not JSON - ignore
          }
          logBuffer.lines.push(logBuffer.partialLine.trim());
        }
        logBuffer.partialLine = "";
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
        parseStderrForErrors(text, errorTracker);
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

  return { exitCode: exitCode ?? 1, errorTracker };
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

  const freshEnv = await fetchResolvedEnv(opts.apiUrl || "", opts.apiKey || "", opts.agentId || "");

  const proc = Bun.spawn(Cmd, {
    env: {
      ...freshEnv,
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
    const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now(), partialLine: "" };
    const shouldStream = opts.apiUrl && opts.sessionId && opts.iteration;

    // Track error signals from Claude CLI output for meaningful failure reasons
    const errorTracker = new SessionErrorTracker();

    const stdoutPromise = (async () => {
      if (proc.stdout) {
        for await (const chunk of proc.stdout) {
          stdoutChunks++;
          const text = new TextDecoder().decode(chunk);
          logFileHandle.write(text);

          // Prepend any partial line from previous chunk
          const combined = logBuffer.partialLine + text;
          const parts = combined.split("\n");

          // Last element may be incomplete - save for next chunk
          logBuffer.partialLine = parts.pop() || "";

          // Process only complete lines (those that ended with \n)
          for (const line of parts) {
            prettyPrintLine(line, role);

            // Extract cost data from result messages
            if (shouldStream && line.trim()) {
              try {
                const json = JSON.parse(line.trim());
                // Capture Claude session ID from init message
                if (json.type === "system" && json.subtype === "init" && json.session_id) {
                  if (opts.taskId) {
                    saveClaudeSessionId(
                      opts.apiUrl || "",
                      opts.apiKey || "",
                      opts.taskId,
                      json.session_id,
                    ).catch((err) => console.warn(`[runner] Failed to save session ID: ${err}`));
                  }
                }
                if (json.type === "result" && json.total_cost_usd !== undefined) {
                  // Extract token data from the usage object
                  // Claude's result JSON has: usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, usage.cache_creation_input_tokens
                  const usage = json.usage as
                    | {
                        input_tokens?: number;
                        output_tokens?: number;
                        cache_read_input_tokens?: number;
                        cache_creation_input_tokens?: number;
                      }
                    | undefined;

                  // Fire and forget - don't block the stream
                  saveCostData(
                    {
                      sessionId: opts.sessionId!,
                      taskId: opts.taskId,
                      agentId: opts.agentId || "",
                      totalCostUsd: json.total_cost_usd || 0,
                      inputTokens: usage?.input_tokens ?? 0,
                      outputTokens: usage?.output_tokens ?? 0,
                      cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
                      cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
                      durationMs: json.duration_ms || 0,
                      numTurns: json.num_turns || 1,
                      model: "opus",
                      isError: json.is_error || false,
                    },
                    opts.apiUrl!,
                    opts.apiKey || "",
                  ).catch((err) => console.warn(`[runner] Failed to save cost: ${err}`));
                }

                // Track error signals for meaningful failure reasons
                trackErrorFromJson(json, errorTracker);
              } catch {
                // Ignore parse errors - not all lines are JSON
              }

              // Buffer for log streaming
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

        // Handle any remaining partial line at stream end
        if (logBuffer.partialLine.trim()) {
          prettyPrintLine(logBuffer.partialLine, role);
          if (shouldStream) {
            // Try to extract cost data and error signals from final partial line
            try {
              const json = JSON.parse(logBuffer.partialLine.trim());
              if (json.type === "result" && json.total_cost_usd !== undefined) {
                const usage = json.usage as
                  | {
                      input_tokens?: number;
                      output_tokens?: number;
                      cache_read_input_tokens?: number;
                      cache_creation_input_tokens?: number;
                    }
                  | undefined;
                saveCostData(
                  {
                    sessionId: opts.sessionId!,
                    taskId: opts.taskId,
                    agentId: opts.agentId || "",
                    totalCostUsd: json.total_cost_usd || 0,
                    inputTokens: usage?.input_tokens ?? 0,
                    outputTokens: usage?.output_tokens ?? 0,
                    cacheReadTokens: usage?.cache_read_input_tokens ?? 0,
                    cacheWriteTokens: usage?.cache_creation_input_tokens ?? 0,
                    durationMs: json.duration_ms || 0,
                    numTurns: json.num_turns || 1,
                    model: "opus",
                    isError: json.is_error || false,
                  },
                  opts.apiUrl!,
                  opts.apiKey || "",
                ).catch((err) => console.warn(`[runner] Failed to save cost: ${err}`));
              }
              trackErrorFromJson(json, errorTracker);
            } catch {
              // Ignore parse errors
            }
            logBuffer.lines.push(logBuffer.partialLine.trim());
          }
          logBuffer.partialLine = "";
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
          parseStderrForErrors(text, errorTracker);
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

    return { exitCode: exitCode ?? 1, errorTracker };
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
async function checkCompletedProcesses(
  state: RunnerState,
  role: string,
  apiConfig?: ApiConfig,
): Promise<void> {
  const completedTasks: Array<{
    taskId: string;
    exitCode: number;
    triggerType?: string;
    notifiedTaskIds?: string[];
    promise: RunningTask["promise"];
  }> = [];

  for (const [taskId, task] of state.activeTasks) {
    // Check if the Bun subprocess has exited (non-blocking)
    if (task.process.exitCode !== null) {
      console.log(
        `[${role}] Task ${taskId.slice(0, 8)} completed with exit code ${task.process.exitCode} (trigger: ${task.triggerType || "unknown"})`,
      );
      completedTasks.push({
        taskId,
        exitCode: task.process.exitCode,
        triggerType: task.triggerType,
        notifiedTaskIds: task.notifiedTaskIds,
        promise: task.promise,
      });
    }
  }

  // Remove completed tasks from the map and ensure they're marked as finished
  for (const { taskId, exitCode, triggerType, notifiedTaskIds, promise } of completedTasks) {
    state.activeTasks.delete(taskId);

    // Call the finish API to ensure task status is updated
    // This is idempotent - if the agent already marked it, this is a no-op
    if (apiConfig) {
      // Await the promise to get error tracker with detailed failure info
      let failureReason: string | undefined;
      if (exitCode !== 0) {
        try {
          const result = await promise;
          if (result.errorTracker.hasErrors()) {
            failureReason = result.errorTracker.buildFailureReason(exitCode);
            console.log(
              `[${role}] Detected error for task ${taskId.slice(0, 8)}: ${failureReason}`,
            );
          }
        } catch {
          // Promise rejection - use default failure reason
        }
      }
      await ensureTaskFinished(apiConfig, role, taskId, exitCode, failureReason);
    }

    // If this was a tasks_finished trigger that failed, reset the notifications
    // so those tasks will be re-delivered on the next poll. This prevents permanent
    // notification loss from the mark-before-process race condition.
    if (
      exitCode !== 0 &&
      triggerType === "tasks_finished" &&
      notifiedTaskIds?.length &&
      apiConfig
    ) {
      console.log(
        `[${role}] Session failed (exit ${exitCode}) for tasks_finished trigger — resetting notification for ${notifiedTaskIds.length} task(s)`,
      );
      await resetTaskNotifications(apiConfig, role, notifiedTaskIds, exitCode);
    }
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

  // Agent identity fields — populated after registration by fetching full profile
  let agentSoulMd: string | undefined;
  let agentIdentityMd: string | undefined;
  let agentSetupScript: string | undefined;
  let agentToolsMd: string | undefined;
  let agentProfileName: string | undefined;
  let agentDescription: string | undefined;

  // Per-task repo context — set when processing a task with githubRepo
  let currentRepoContext: BasePromptArgs["repoContext"] | undefined;

  // Generate base prompt (identity fields injected after profile fetch below)
  const buildSystemPrompt = () => {
    return getBasePrompt({
      role,
      agentId,
      swarmUrl,
      capabilities,
      name: agentProfileName,
      description: agentDescription,
      soulMd: agentSoulMd,
      identityMd: agentIdentityMd,
      repoContext: currentRepoContext,
    });
  };

  let basePrompt = buildSystemPrompt();

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
  // Note: resolvedSystemPrompt is rebuilt after profile fetch when identity is available
  let resolvedSystemPrompt = additionalSystemPrompt
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

    // Fetch full agent profile to get soul/identity content
    try {
      const resp = await fetch(`${apiUrl}/me`, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "X-Agent-ID": agentId,
        },
      });
      if (resp.ok) {
        const profile = (await resp.json()) as {
          soulMd?: string;
          identityMd?: string;
          claudeMd?: string;
          setupScript?: string;
          toolsMd?: string;
          name?: string;
          description?: string;
        };
        agentSoulMd = profile.soulMd;
        agentIdentityMd = profile.identityMd;
        agentSetupScript = profile.setupScript;
        agentToolsMd = profile.toolsMd;
        agentProfileName = profile.name;
        agentDescription = profile.description;

        // Generate default templates if missing (runner registers via POST /api/agents
        // which doesn't generate templates like join-swarm does)
        if (!agentSoulMd || !agentIdentityMd || !agentToolsMd) {
          const agentInfo = {
            name: agentProfileName || agentName,
            role: role,
            description: agentDescription,
            capabilities: config.capabilities,
          };
          if (!agentSoulMd) agentSoulMd = generateDefaultSoulMd(agentInfo);
          if (!agentIdentityMd) agentIdentityMd = generateDefaultIdentityMd(agentInfo);
          if (!agentToolsMd) agentToolsMd = generateDefaultToolsMd(agentInfo);
          const defaultClaudeMd = !profile.claudeMd
            ? generateDefaultClaudeMd(agentInfo)
            : undefined;

          // Push generated templates to server
          try {
            const profileUpdate: Record<string, string> = {};
            if (!profile.soulMd) profileUpdate.soulMd = agentSoulMd;
            if (!profile.identityMd) profileUpdate.identityMd = agentIdentityMd;
            if (!profile.toolsMd) profileUpdate.toolsMd = agentToolsMd;
            if (defaultClaudeMd) profileUpdate.claudeMd = defaultClaudeMd;

            await fetch(`${apiUrl}/api/agents/${agentId}/profile`, {
              method: "PUT",
              headers: {
                Authorization: `Bearer ${apiKey}`,
                "X-Agent-ID": agentId,
                "Content-Type": "application/json",
              },
              body: JSON.stringify(profileUpdate),
            });
            console.log(`[${role}] Generated and saved default identity templates`);
          } catch {
            console.warn(`[${role}] Could not save generated templates to server`);
          }
        }

        // Rebuild system prompt with identity
        basePrompt = buildSystemPrompt();
        resolvedSystemPrompt = additionalSystemPrompt
          ? `${basePrompt}\n\n${additionalSystemPrompt}`
          : basePrompt;
        console.log(
          `[${role}] Loaded agent identity (soul: ${agentSoulMd ? "yes" : "no"}, identity: ${agentIdentityMd ? "yes" : "no"})`,
        );
        console.log(`[${role}] Updated system prompt length: ${resolvedSystemPrompt.length} chars`);
      }
    } catch {
      console.warn(`[${role}] Could not fetch agent profile for identity — proceeding without`);
    }

    // Write SOUL.md and IDENTITY.md to workspace before spawning Claude
    const SOUL_MD_PATH = "/workspace/SOUL.md";
    const IDENTITY_MD_PATH = "/workspace/IDENTITY.md";

    if (agentSoulMd) {
      try {
        await Bun.write(SOUL_MD_PATH, agentSoulMd);
        console.log(`[${role}] Wrote SOUL.md to workspace`);
      } catch (err) {
        console.warn(`[${role}] Could not write SOUL.md: ${(err as Error).message}`);
      }
    }
    if (agentIdentityMd) {
      try {
        await Bun.write(IDENTITY_MD_PATH, agentIdentityMd);
        console.log(`[${role}] Wrote IDENTITY.md to workspace`);
      } catch (err) {
        console.warn(`[${role}] Could not write IDENTITY.md: ${(err as Error).message}`);
      }
    }

    // Write setup script to workspace (agent can edit during session)
    // Only create if it doesn't exist — the entrypoint already composed/prepended it at container start
    if (agentSetupScript) {
      try {
        if (!(await Bun.file("/workspace/start-up.sh").exists())) {
          await Bun.write("/workspace/start-up.sh", `#!/bin/bash\n${agentSetupScript}\n`);
          console.log(`[${role}] Wrote start-up.sh to workspace`);
        }
      } catch (err) {
        console.warn(`[${role}] Could not write start-up.sh: ${(err as Error).message}`);
      }
    }

    // Write TOOLS.md to workspace (agent can edit during session)
    if (agentToolsMd) {
      try {
        await Bun.write("/workspace/TOOLS.md", agentToolsMd);
        console.log(`[${role}] Wrote TOOLS.md to workspace`);
      } catch (err) {
        console.warn(`[${role}] Could not write TOOLS.md: ${(err as Error).message}`);
      }
    }

    // ========== Resume paused tasks with PRIORITY ==========
    // Check for paused tasks from previous shutdown and resume them before normal polling
    try {
      console.log(`[${role}] Checking for paused tasks to resume...`);
      const pausedTasks = await getPausedTasksFromAPI(apiConfig);

      if (pausedTasks.length > 0) {
        console.log(`[${role}] Found ${pausedTasks.length} paused task(s) to resume`);

        for (const task of pausedTasks) {
          // Wait if at capacity (though unlikely on fresh startup)
          while (state.activeTasks.size >= state.maxConcurrent) {
            await checkCompletedProcesses(state, role, apiConfig);
            await Bun.sleep(1000);
          }

          console.log(
            `[${role}] Resuming paused task ${task.id.slice(0, 8)}: "${task.task.slice(0, 50)}..."`,
          );

          // Resume the task via API (marks as in_progress)
          const resumed = await resumeTaskViaAPI(apiConfig, task.id);
          if (!resumed) {
            console.warn(
              `[${role}] Failed to resume task ${task.id.slice(0, 8)} via API, skipping`,
            );
            continue;
          }

          // Build prompt with resume context
          const resumePrompt = buildResumePrompt(task);

          // Resolve --resume: prefer own session ID, then parent's
          let resumeAdditionalArgs = opts.additionalArgs || [];
          if (task.claudeSessionId) {
            resumeAdditionalArgs = [...resumeAdditionalArgs, "--resume", task.claudeSessionId];
            console.log(
              `[${role}] Resuming task's own session ${task.claudeSessionId.slice(0, 8)}`,
            );
          } else if (task.parentTaskId) {
            const parentSessionId = await fetchClaudeSessionId(apiUrl, apiKey, task.parentTaskId);
            if (parentSessionId) {
              resumeAdditionalArgs = [...resumeAdditionalArgs, "--resume", parentSessionId];
              console.log(`[${role}] Resuming parent session ${parentSessionId.slice(0, 8)}`);
            }
          }

          // Spawn Claude process for resumed task
          iteration++;
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const logFile = `${logDir}/${timestamp}-resume-${task.id.slice(0, 8)}.jsonl`;

          console.log(`\n[${role}] === Resuming paused task (iteration ${iteration}) ===`);
          console.log(`[${role}] Logging to: ${logFile}`);
          console.log(`[${role}] Prompt: ${resumePrompt.slice(0, 100)}...`);

          const metadata = {
            type: metadataType,
            sessionId,
            iteration,
            timestamp: new Date().toISOString(),
            prompt: resumePrompt,
            trigger: "task_resumed",
            resumedTaskId: task.id,
            yolo: isYolo,
          };
          await Bun.write(logFile, `${JSON.stringify(metadata)}\n`);

          const runningTask = await spawnClaudeProcess(
            {
              prompt: resumePrompt,
              logFile,
              systemPrompt: resolvedSystemPrompt,
              additionalArgs: resumeAdditionalArgs,
              role,
              apiUrl,
              apiKey,
              agentId,
              sessionId,
              iteration,
              taskId: task.id,
            },
            logDir,
            metadataType,
            sessionId,
            isYolo,
          );

          state.activeTasks.set(task.id, runningTask);
          console.log(
            `[${role}] Resumed task ${task.id.slice(0, 8)} (${state.activeTasks.size}/${state.maxConcurrent} active)`,
          );
        }

        console.log(`[${role}] All paused tasks resumed. Entering normal polling...`);
      } else {
        console.log(`[${role}] No paused tasks found. Entering normal polling...`);
      }
    } catch (error) {
      console.error(`[${role}] Error checking/resuming paused tasks: ${error}`);
      // Continue to normal polling even if resume fails
    }
    // ========== END: Resume paused tasks ==========

    // Track last finished task check for leads (to avoid re-processing)
    let lastFinishedTaskCheck: string | undefined;

    while (true) {
      // Ping server on each iteration to keep status updated
      await pingServer(apiConfig, role);

      // Check for completed processes first and ensure tasks are marked as finished
      await checkCompletedProcesses(state, role, apiConfig);

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
          // Extract finished task IDs before processing (for notification reset on failure)
          let notifiedTaskIds: string[] | undefined;
          if (trigger.type === "tasks_finished") {
            lastFinishedTaskCheck = new Date().toISOString();
            notifiedTaskIds = trigger.tasks?.map((t) => t.id);
            console.log(
              `[${role}] Trigger received: tasks_finished (${trigger.count} task(s): ${notifiedTaskIds?.map((id) => id.slice(0, 8)).join(", ") || "none"})`,
            );
          } else {
            console.log(`[${role}] Trigger received: ${trigger.type}`);
          }

          // Build prompt based on trigger
          const triggerPrompt = buildPromptForTrigger(trigger, prompt);

          // Resolve --resume for child tasks with parentTaskId
          let effectiveAdditionalArgs = opts.additionalArgs || [];
          const taskObj = trigger.task as { parentTaskId?: string } | undefined;
          if (taskObj?.parentTaskId) {
            const parentSessionId = await fetchClaudeSessionId(
              apiUrl,
              apiKey,
              taskObj.parentTaskId,
            );
            if (parentSessionId) {
              effectiveAdditionalArgs = [...effectiveAdditionalArgs, "--resume", parentSessionId];
              console.log(
                `[${role}] Child task — resuming parent session ${parentSessionId.slice(0, 8)}`,
              );
            } else {
              console.log(`[${role}] Child task — parent session ID not found, starting fresh`);
            }
          }

          // Handle repo context for tasks with githubRepo
          const taskGithubRepo = (trigger.task as { githubRepo?: string } | undefined)?.githubRepo;
          if (taskGithubRepo && apiUrl) {
            const repoConfig = await fetchRepoConfig(apiUrl, apiKey, taskGithubRepo);
            // Fall back to convention-based config if repo is not registered
            const effectiveConfig = repoConfig ?? {
              url: taskGithubRepo,
              name: taskGithubRepo.split("/").pop() || taskGithubRepo,
              clonePath: `/workspace/repos/${taskGithubRepo.split("/").pop() || taskGithubRepo}`,
              defaultBranch: "main",
            };
            currentRepoContext = await ensureRepoForTask(effectiveConfig, role);
          } else {
            currentRepoContext = undefined;
          }

          // Rebuild system prompt with per-task repo context
          const taskBasePrompt = buildSystemPrompt();
          const taskSystemPrompt = additionalSystemPrompt
            ? `${taskBasePrompt}\n\n${additionalSystemPrompt}`
            : taskBasePrompt;

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
              systemPrompt: taskSystemPrompt,
              additionalArgs: effectiveAdditionalArgs,
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

          // Attach trigger metadata for post-completion handling (e.g., notification reset)
          runningTask.triggerType = trigger.type;
          if (notifiedTaskIds?.length) {
            runningTask.notifiedTaskIds = notifiedTaskIds;
          }

          state.activeTasks.set(runningTask.taskId, runningTask);
          console.log(
            `[${role}] Started task ${runningTask.taskId.slice(0, 8)} (${state.activeTasks.size}/${state.maxConcurrent} active, trigger: ${trigger.type})`,
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

      const { exitCode, errorTracker } = await runClaudeIteration({
        prompt,
        logFile,
        systemPrompt: resolvedSystemPrompt,
        additionalArgs: opts.additionalArgs,
        role,
        apiUrl,
        apiKey,
        agentId,
      });

      if (exitCode !== 0) {
        const failureReason = errorTracker.hasErrors()
          ? errorTracker.buildFailureReason(exitCode)
          : `Claude process exited with code ${exitCode}`;

        const errorLog = {
          timestamp: new Date().toISOString(),
          iteration,
          exitCode,
          failureReason,
          error: true,
        };

        const errorsFile = `${logDir}/errors.jsonl`;
        const errorsFileRef = Bun.file(errorsFile);
        const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
        await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

        if (!isYolo) {
          console.error(`[${role}] ${failureReason}. Stopping.`);
          console.error(`[${role}] Error logged to: ${errorsFile}`);
          process.exit(exitCode);
        }

        console.warn(`[${role}] ${failureReason}. YOLO mode - continuing...`);
      }

      console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
    }
  }
}
