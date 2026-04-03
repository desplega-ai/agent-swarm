import { existsSync, statSync } from "node:fs";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { ensure, initialize } from "@desplega.ai/business-use";
import type { TemplateResponse } from "../../templates/schema.ts";
import { type BasePromptArgs, getBasePrompt } from "../prompts/base-prompt.ts";
import {
  generateDefaultClaudeMd,
  generateDefaultIdentityMd,
  generateDefaultSoulMd,
  generateDefaultToolsMd,
} from "../prompts/defaults.ts";
import { configureHttpResolver, resolveTemplateAsync } from "../prompts/resolver.ts";
import {
  type CostData,
  createProviderAdapter,
  type ProviderResult,
  type ProviderSession,
  type ProviderSessionConfig,
} from "../providers/index.ts";
import { getContextWindowSize } from "../utils/context-window.ts";
import { type CredentialSelection, resolveCredentialPools } from "../utils/credentials.ts";
import { parseRateLimitResetTime } from "../utils/error-tracker.ts";
import { prettyPrintLine, prettyPrintStderr } from "../utils/pretty-print.ts";
import { detectVcsProvider } from "../vcs/index.ts";
import { interpolate } from "../workflows/template.ts";
// Side-effect import: registers runner trigger/resumption templates
import "./templates.ts";

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

/** Fetch repo config for a task's vcsRepo (e.g., "desplega-ai/agent-swarm") */
async function fetchRepoConfig(
  apiUrl: string,
  apiKey: string,
  vcsRepo: string,
): Promise<{ url: string; name: string; clonePath: string; defaultBranch: string } | null> {
  try {
    const repoName = vcsRepo.split("/").pop() || vcsRepo;
    const resp = await fetch(`${apiUrl}/api/repos?name=${encodeURIComponent(repoName)}`, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!resp.ok) return null;
    const data = (await resp.json()) as {
      repos: Array<{ url: string; name: string; clonePath: string; defaultBranch: string }>;
    };
    return data.repos.find((r) => r.url.includes(vcsRepo)) ?? data.repos[0] ?? null;
  } catch {
    return null;
  }
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
      const provider = detectVcsProvider(url);
      if (provider === "github") {
        await Bun.$`gh repo clone ${url} ${clonePath} -- --branch ${defaultBranch} --single-branch`.quiet();
      } else if (provider === "gitlab") {
        await Bun.$`glab repo clone ${url} ${clonePath} -- --branch ${defaultBranch} --single-branch`.quiet();
      } else {
        await Bun.$`git clone --branch ${defaultBranch} --single-branch ${url} ${clonePath}`.quiet();
      }
      // Validate the clone actually created the directory
      if (!existsSync(clonePath)) {
        throw new Error(`Clone command succeeded but directory ${clonePath} does not exist`);
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
    // Only return clonePath if the directory actually exists (clone may have failed)
    const cloneExists = existsSync(clonePath);
    return { clonePath: cloneExists ? clonePath : "", claudeMd: null, warning };
  }
}

/** API configuration for ping/close */
export interface ApiConfig {
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
 * Credential env vars with comma-separated values get one randomly selected.
 */
interface ResolvedEnvResult {
  env: Record<string, string | undefined>;
  credentialSelections: CredentialSelection[];
}

async function fetchResolvedEnv(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  baseEnv: Record<string, string | undefined> = process.env,
): Promise<ResolvedEnvResult> {
  const env: Record<string, string | undefined> = { ...baseEnv };

  if (apiUrl && agentId) {
    try {
      const headers: Record<string, string> = { "X-Agent-ID": agentId };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

      const url = `${apiUrl}/api/config/resolved?agentId=${encodeURIComponent(agentId)}&includeSecrets=true`;
      const response = await fetch(url, { headers });

      if (!response.ok) {
        console.warn(`[env-reload] Failed to fetch config: ${response.status}`);
      } else {
        const data = (await response.json()) as {
          configs: Array<{ key: string; value: string }>;
        };

        if (data.configs?.length) {
          for (const config of data.configs) {
            env[config.key] = config.value;
          }
          console.log(`[env-reload] Loaded ${data.configs.length} config entries from API`);
        }
      }
    } catch (error) {
      console.warn(`[env-reload] Could not fetch config, using current env: ${error}`);
    }
  }

  const credentialSelections = await resolveCredentialPools(env, { apiUrl, apiKey });

  return { env, credentialSelections };
}

/** Tools that produce noise — skip auto-progress for these */
const SKIP_PROGRESS_TOOLS = new Set(["ToolSearch", "TodoRead", "TodoWrite"]);

/** Pretty labels for agent-swarm MCP tools. null = skip (meta/noise). */
const SWARM_TOOL_LABELS: Record<string, string | null> = {
  "store-progress": null,
  "get-task-details": "📋 Reviewing task details",
  "get-tasks": "📋 Checking task list",
  "poll-task": "📡 Polling for tasks",
  "send-task": "📤 Delegating task",
  "task-action": "⚡ Performing task action",
  "join-swarm": "🔗 Joining swarm",
  "my-agent-info": "🪪 Checking agent info",
  "get-swarm": "👥 Checking swarm status",
  "post-message": "💬 Sending message",
  "read-messages": "💬 Reading messages",
  "request-human-input": "🙋 Requesting human input",
  "cancel-task": "🚫 Cancelling task",
  "db-query": "🗃️ Querying database",
  "inject-learning": "🧠 Storing learning",
  "memory-search": "🧠 Searching memory",
  "memory-get": "🧠 Retrieving memory",
  "update-profile": "🪪 Updating profile",
  // Slack
  "slack-post": "💬 Posting to Slack",
  "slack-reply": "💬 Replying in Slack",
  "slack-read": "💬 Reading Slack",
  "slack-list-channels": "💬 Listing Slack channels",
  "slack-download-file": "📥 Downloading from Slack",
  "slack-upload-file": "📤 Uploading to Slack",
  // Tracker
  "tracker-status": "📊 Checking tracker status",
  "tracker-sync-status": "📊 Syncing tracker status",
  "tracker-link-task": "🔗 Linking task to tracker",
  "tracker-unlink": "🔗 Unlinking from tracker",
  "tracker-map-agent": "🔗 Mapping agent to tracker",
  // Workflows
  "trigger-workflow": "⚙️ Triggering workflow",
  "get-workflow": "⚙️ Checking workflow",
  "list-workflows": "⚙️ Listing workflows",
  "create-workflow": "⚙️ Creating workflow",
  // Skills
  "skill-search": "🔎 Searching skills",
  "skill-install": "📦 Installing skill",
  "skill-install-remote": "📦 Installing remote skill",
  "skill-get": "📦 Getting skill details",
  "skill-list": "📦 Listing skills",
  // Config
  "get-config": "⚙️ Reading config",
  "set-config": "⚙️ Setting config",
  "list-config": "⚙️ Listing config",
  // Schedules
  "create-schedule": "📅 Creating schedule",
  "list-schedules": "📅 Listing schedules",
  "run-schedule-now": "📅 Running schedule",
  // Context
  "context-diff": "📜 Viewing context diff",
  "context-history": "📜 Viewing context history",
  // Channels
  "create-channel": "📢 Creating channel",
  "list-channels": "📢 Listing channels",
  "delete-channel": "📢 Deleting channel",
  // Services
  "register-service": "🔌 Registering service",
  "list-services": "🔌 Listing services",
  "unregister-service": "🔌 Unregistering service",
  "update-service-status": "🔌 Updating service status",
};

/** Convert kebab-case to sentence case: "get-task-details" → "Get task details" */
export function humanizeToolName(name: string): string {
  if (!name) return name;
  return name.charAt(0).toUpperCase() + name.slice(1).replaceAll("-", " ");
}

/**
 * Convert a tool call into a human-readable progress description.
 * Returns null for noisy/meta tools that should be skipped.
 */
export function toolCallToProgress(toolName: string, args: unknown): string | null {
  if (SKIP_PROGRESS_TOOLS.has(toolName)) return null;

  // Normalize: pi-mono uses lowercase ("read"), Claude uses PascalCase ("Read")
  const normalized =
    toolName.startsWith("mcp__") || toolName.includes("_")
      ? toolName
      : toolName.charAt(0).toUpperCase() + toolName.slice(1);

  const a = args as Record<string, unknown>;
  const shortPath = (p: unknown) => {
    if (typeof p !== "string") return "";
    // Show last 2 path segments for readability
    const parts = p.split("/");
    return parts.length > 2 ? parts.slice(-2).join("/") : p;
  };

  switch (normalized) {
    case "Read":
      return `📖 Reading ${shortPath(a.file_path)}`;
    case "Edit":
    case "MultiEdit":
      return `✏️ Editing ${shortPath(a.file_path)}`;
    case "Write":
      return `📝 Writing ${shortPath(a.file_path)}`;
    case "Bash":
      return a.description ? `⚡ ${a.description}` : "⚡ Running shell command";
    case "Grep":
      return `🔍 Searching for "${a.pattern}"`;
    case "Glob":
      return `📁 Finding files matching ${a.pattern}`;
    case "Agent":
    case "Task":
      return a.description ? `🤖 ${a.description}` : "🤖 Delegating sub-task";
    case "Skill":
      return `⚙️ Running /${a.skill}`;
    default: {
      // MCP tools: mcp__server__tool
      if (toolName.startsWith("mcp__")) {
        const parts = toolName.split("__");
        if (parts.length >= 3) {
          const server = parts[1];
          const tool = parts.slice(2).join("__");
          // Agent-swarm tools get pretty labels
          if (server === "agent-swarm") {
            const label = SWARM_TOOL_LABELS[tool];
            if (label === null) return null; // skip
            if (label) return label;
            return `🔌 ${humanizeToolName(tool)}`;
          }
          // Other MCP servers: "🔌 server: Humanized tool"
          return `🔌 ${server}: ${humanizeToolName(tool)}`;
        }
        return `🔌 ${toolName}`;
      }
      return `🔧 ${toolName}`;
    }
  }
}

/**
 * Report task progress via the API (fire-and-forget).
 */
async function updateProgressViaAPI(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  progress: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  try {
    await fetch(`${apiUrl}/api/tasks/${taskId}/progress`, {
      method: "POST",
      headers,
      body: JSON.stringify({ progress }),
    });
  } catch {
    // Non-blocking — progress update failure is not critical
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
/**
 * Attempt to extract structured output from a task's progress history
 * when the agent session ends without calling store-progress with valid output.
 *
 * - Claude adapter: runs a fallback extraction via `claude -p --json-schema`
 * - Pi-mono adapter: returns an error (no fallback available)
 */
export type FallbackResult =
  | { kind: "extracted"; output: string }
  | { kind: "already-has-output" }
  | { kind: "no-schema"; lastProgress?: string }
  | { kind: "schema-fail"; failReason: string }
  | { kind: "fetch-error"; error: string };

export async function handleStructuredOutputFallback(
  config: ApiConfig,
  taskId: string,
  adapterType: string,
): Promise<FallbackResult> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (config.apiKey) {
    headers.Authorization = `Bearer ${config.apiKey}`;
  }

  try {
    // Fetch the task to check for outputSchema
    const taskRes = await fetch(`${config.apiUrl}/api/tasks/${taskId}`, { headers });
    if (!taskRes.ok) return { kind: "fetch-error", error: `HTTP ${taskRes.status}` };

    // Response is a flat spread of task fields + logs (see src/http/tasks.ts)
    const taskData = (await taskRes.json()) as {
      id?: string;
      task?: string;
      status?: string;
      output?: string;
      progress?: string;
      outputSchema?: Record<string, unknown>;
      logs?: Array<{ eventType: string; newValue?: string; createdAt?: string }>;
    };

    if (!taskData.outputSchema) {
      // No structured output required — extract last progress as context
      const lastProgressLog = (taskData.logs ?? [])
        .filter((l) => l.eventType === "task_progress")
        .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
      const lastProgress = lastProgressLog?.newValue ?? taskData.progress;
      return { kind: "no-schema", lastProgress: lastProgress || undefined };
    }

    if (taskData.output) return { kind: "already-has-output" };

    if (adapterType !== "claude") {
      return {
        kind: "schema-fail",
        failReason:
          "Structured output required by outputSchema but not provided via store-progress",
      };
    }

    // Claude adapter fallback: extract structured data from progress history
    const progressLogs = (taskData.logs ?? [])
      .filter((l) => l.eventType === "task_progress")
      .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""));

    const progressEntries = progressLogs
      .map((log, i) => `${i + 1}. [${log.createdAt}] ${log.newValue}`)
      .join("\n");

    const extractionPrompt = `Extract structured data from this task's execution history.

## Task Description
${taskData.task || "(no description)"}

## Progress Updates (chronological)
${progressEntries || "(no progress recorded)"}

## Required Output Schema
${JSON.stringify(taskData.outputSchema, null, 2)}

Extract the structured data from the progress updates above. Return ONLY valid JSON matching the schema.`;

    const schemaJson = JSON.stringify(taskData.outputSchema);
    const result =
      await Bun.$`claude -p ${extractionPrompt} --json-schema ${schemaJson} --output-format json --model sonnet`
        .json()
        .catch(() => null);

    if (result && typeof result === "object") {
      return { kind: "extracted", output: JSON.stringify(result) };
    }

    return {
      kind: "schema-fail",
      failReason: "Structured output extraction fallback failed — could not produce valid JSON",
    };
  } catch (err) {
    console.warn(`[runner] Structured output fallback failed for task ${taskId}: ${err}`);
    return { kind: "fetch-error", error: String(err) };
  }
}

export async function ensureTaskFinished(
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
  let status = exitCode === 0 ? "completed" : "failed";
  const body: Record<string, string> = { status };

  if (status === "failed") {
    body.failureReason = failureReason || `Claude process exited with code ${exitCode}`;
  } else {
    // Try structured output fallback if the task has an outputSchema
    const adapterType = process.env.HARNESS_PROVIDER || "claude";
    const fallback = await handleStructuredOutputFallback(config, taskId, adapterType);

    console.log(`[${role}] Task ${taskId.slice(0, 8)} fallback result: ${fallback.kind}`);

    switch (fallback.kind) {
      case "extracted":
        body.output = fallback.output;
        break;
      case "already-has-output":
        body.output = "Process completed successfully";
        break;
      case "no-schema": {
        if (fallback.lastProgress) {
          body.output = fallback.lastProgress.slice(0, 2000);
        } else {
          body.output = "Process completed successfully (no output captured)";
        }
        break;
      }
      case "schema-fail":
        status = "failed";
        body.status = "failed";
        body.failureReason = fallback.failReason;
        break;
      case "fetch-error":
        body.output = `Process completed (could not verify task state: ${fallback.error})`;
        break;
    }
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

/** Report key usage to the API (fire-and-forget) */
async function reportKeyUsage(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  selection: CredentialSelection,
  taskId?: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/keys/report-usage`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        keyType,
        keySuffix: selection.keySuffix,
        keyIndex: selection.index,
        taskId,
      }),
    });
  } catch {
    // Non-blocking
  }
}

/** Report a rate-limited key to the API (fire-and-forget) */
async function reportKeyRateLimit(
  apiUrl: string,
  apiKey: string,
  keyType: string,
  keySuffix: string,
  keyIndex: number,
  rateLimitedUntil: string,
): Promise<void> {
  try {
    await fetch(`${apiUrl}/api/keys/report-rate-limit`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        keyType,
        keySuffix,
        keyIndex,
        rateLimitedUntil,
      }),
    });
    console.log(
      `[credentials] Reported key ...${keySuffix} as rate-limited until ${rateLimitedUntil}`,
    );
  } catch {
    // Non-blocking
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
    dir?: string;
    vcsRepo?: string;
    finishedAt?: string;
    output?: string;
    status?: string;
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
        dir?: string;
        vcsRepo?: string;
        finishedAt?: string;
        output?: string;
        status?: string;
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
async function buildResumePrompt(
  task: { id: string; task: string; progress?: string },
  fmt: (cmd: string) => string = (cmd) => `/${cmd}`,
): Promise<string> {
  if (task.progress) {
    const result = await resolveTemplateAsync("task.resumption.with_progress", {
      work_on_task_cmd: fmt("work-on-task"),
      task_id: task.id,
      task_description: task.task,
      progress: task.progress,
    });
    return result.text;
  }

  const result = await resolveTemplateAsync("task.resumption.no_progress", {
    work_on_task_cmd: fmt("work-on-task"),
    task_id: task.id,
    task_description: task.task,
  });
  return result.text;
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
          task.session.abort().catch(() => {});
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

/** Running task state for parallel execution */
interface RunningTask {
  taskId: string;
  session: ProviderSession;
  logFile: string;
  startTime: Date;
  promise: Promise<ProviderResult>;
  /** The trigger type that caused this task to be spawned */
  triggerType?: string;
  /** Set when the promise resolves, enabling non-blocking completion checks */
  result: ProviderResult | null;
  /** Deferred cursor updates for channel_activity triggers — committed after success */
  cursorUpdates?: Array<{ channelId: string; ts: string }>;
  /** Resolved working directory for VCS detection */
  workingDir?: string;
  /** Credential tracking: which key was used for this task */
  credentialInfo?: {
    keyType: string;
    keySuffix: string;
    keyIndex: number;
  };
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

  // Snapshot and clear buffer immediately to prevent duplicate flushes
  // (fire-and-forget callers would otherwise race on the same buffer)
  const lines = buffer.lines;
  buffer.lines = [];
  buffer.lastFlush = Date.now();

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
        lines,
      }),
    });

    if (!response.ok) {
      console.warn(`[runner] Failed to push logs: ${response.status}`);
    }
  } catch (error) {
    console.warn(`[runner] Error pushing logs: ${error}`);
  }
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
async function saveProviderSessionId(
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

/** Cache of tasks that already have VCS linked — prevents repeated gh pr list calls */
const vcsDetectedTasks = new Set<string>();

/** Throttle timestamps for periodic VCS checks per task */
const vcsCheckTimestamps = new Map<string, number>();
const VCS_CHECK_INTERVAL = 60_000; // 60 seconds

/**
 * Detect if the task's working directory has an open PR for the current branch.
 * If found, report VCS info to the API so webhook events can link back to this task.
 */
async function detectVcsForTask(
  apiUrl: string,
  apiKey: string,
  taskId: string,
  workingDir: string,
): Promise<void> {
  try {
    // 1. Check if inside a git repo
    const isGit = await Bun.$`git -C ${workingDir} rev-parse --is-inside-work-tree`.quiet().text();
    if (isGit.trim() !== "true") return;

    // 2. Get current branch
    const branch = (await Bun.$`git -C ${workingDir} branch --show-current`.quiet().text()).trim();
    if (!branch || branch === "main" || branch === "master") return;

    // 3. Get remote URL to determine provider and repo
    const remoteUrl = (
      await Bun.$`git -C ${workingDir} remote get-url origin`.quiet().text()
    ).trim();

    // 4. Detect provider and check for PR/MR
    let vcsProvider: "github" | "gitlab";
    let prJson: string;

    if (remoteUrl.includes("github.com") || remoteUrl.includes("github")) {
      vcsProvider = "github";
      prJson = (
        await Bun.$`gh pr list --head ${branch} --json number,url --limit 1`.quiet().text()
      ).trim();
    } else if (remoteUrl.includes("gitlab")) {
      vcsProvider = "gitlab";
      prJson = (
        await Bun.$`glab mr list --source-branch ${branch} --json iid,web_url --per-page 1`
          .quiet()
          .text()
      ).trim();
    } else {
      return; // Unknown provider
    }

    // 5. Parse result
    const prs = JSON.parse(prJson);
    if (!Array.isArray(prs) || prs.length === 0) return;

    const pr = prs[0];
    const vcsNumber = pr.number ?? pr.iid;
    const vcsUrl = pr.url ?? pr.web_url;
    if (!vcsNumber || !vcsUrl) return;

    // 6. Extract repo from remote URL
    const repoMatch = remoteUrl.match(/[:/]([^/]+\/[^/.]+?)(?:\.git)?$/);
    if (!repoMatch) return;
    const vcsRepo = repoMatch[1];

    // 7. Report to API
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    await fetch(`${apiUrl}/api/tasks/${taskId}/vcs`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ vcsProvider, vcsRepo, vcsNumber, vcsUrl }),
    });

    vcsDetectedTasks.add(taskId);
    console.log(
      `[VCS] Linked task ${taskId.slice(0, 8)} to ${vcsProvider} ${vcsRepo}#${vcsNumber}`,
    );
  } catch {
    // Fire-and-forget — detection failure should never block task execution
  }
}

/** Save provider session ID on the active session (for pool tasks where realTaskId is unknown) */
async function saveProviderSessionIdOnActiveSession(
  apiUrl: string,
  apiKey: string,
  effectiveTaskId: string,
  providerSessionId: string,
): Promise<void> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  await fetch(`${apiUrl}/api/active-sessions/provider-session/${effectiveTaskId}`, {
    method: "PUT",
    headers,
    body: JSON.stringify({ providerSessionId }),
  });
}

/** Fetch Claude session ID for a task (for --resume) */
async function fetchProviderSessionId(
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

/** Register an active session with the API (fire-and-forget) */
async function registerActiveSession(
  config: ApiConfig,
  session: {
    taskId: string;
    triggerType: string;
    taskDescription?: string;
    runnerSessionId?: string;
  },
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    await fetch(`${config.apiUrl}/api/active-sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        agentId: config.agentId,
        taskId: session.taskId,
        triggerType: session.triggerType,
        taskDescription: session.taskDescription,
        runnerSessionId: session.runnerSessionId,
      }),
    });
  } catch {
    // Non-blocking — session tracking is best-effort
  }
}

/** Remove an active session by taskId (fire-and-forget) */
async function removeActiveSession(config: ApiConfig, taskId: string): Promise<void> {
  const headers: Record<string, string> = { "X-Agent-ID": config.agentId };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    await fetch(`${config.apiUrl}/api/active-sessions/by-task/${taskId}`, {
      method: "DELETE",
      headers,
    });
  } catch {
    // Non-blocking
  }
}

/** Clean up all active sessions for this agent (on startup) */
async function cleanupActiveSessions(config: ApiConfig): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Agent-ID": config.agentId,
  };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
  try {
    await fetch(`${config.apiUrl}/api/active-sessions/cleanup`, {
      method: "POST",
      headers,
      body: JSON.stringify({ agentId: config.agentId }),
    });
  } catch {
    // Non-blocking
  }
}

/** Trigger a heartbeat sweep via the API (lead startup self-check) */
async function triggerHeartbeatSweep(config: ApiConfig): Promise<boolean> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": config.agentId,
    };
    if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;
    const resp = await fetch(`${config.apiUrl}/api/heartbeat/sweep`, {
      method: "POST",
      headers,
    });
    return resp.ok;
  } catch (err) {
    console.warn(`[runner] Failed to trigger heartbeat sweep: ${(err as Error).message}`);
    return false;
  }
}

/** Trigger types returned by the poll API */
interface Trigger {
  type:
    | "task_assigned"
    | "task_offered"
    | "unread_mentions"
    | "pool_tasks_available"
    | "channel_activity";
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
    channelId?: string;
    channelName?: string;
    ts?: string;
    user?: string;
    text?: string;
  }>;
  cursorUpdates?: Array<{ channelId: string; ts: string }>; // Deferred cursor commits for channel_activity
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
  role?: string;
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
      role: opts.role,
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
async function buildPromptForTrigger(
  trigger: Trigger,
  defaultPrompt: string,
  fmt: (cmd: string) => string = (cmd) => `/${cmd}`,
): Promise<string> {
  switch (trigger.type) {
    case "task_assigned": {
      // Use the work-on-task command with task ID and description
      const taskDesc =
        trigger.task && typeof trigger.task === "object" && "task" in trigger.task
          ? (trigger.task as { task: string }).task
          : null;
      const taskDescSection = taskDesc ? `\n\nTask: "${taskDesc}"` : "";

      // Build output instructions — use outputSchema if present, otherwise generic
      const taskObj = trigger.task as Record<string, unknown> | undefined;
      let outputInstructions: string;
      if (taskObj?.outputSchema && typeof taskObj.outputSchema === "object") {
        outputInstructions = `\n\n**Required Output Format**: When completing this task, you MUST call store-progress with output that is valid JSON conforming to this schema:\n\`\`\`json\n${JSON.stringify(taskObj.outputSchema, null, 2)}\n\`\`\`\nCall store-progress with status "completed" and your JSON output. If your output doesn't match the schema, the tool call will fail and you should fix and retry.`;
      } else {
        outputInstructions =
          '\n\nWhen done, use `store-progress` with status: "completed" and include your output.';
      }

      // Include requesting user info if available from the poll trigger
      const requestedBy = (trigger as unknown as Record<string, unknown>).requestedBy as
        | { name: string; email?: string }
        | undefined;
      const requestedBySection = requestedBy
        ? `\n\nRequested by: ${requestedBy.name}${requestedBy.email ? ` (${requestedBy.email})` : ""}`
        : "";

      const result = await resolveTemplateAsync("task.trigger.assigned", {
        work_on_task_cmd: fmt("work-on-task"),
        task_id: trigger.taskId,
        task_desc_section: taskDescSection + requestedBySection,
        output_instructions: outputInstructions,
      });
      return result.text;
    }

    case "task_offered": {
      // Use the review-offered-task command with context
      const taskDesc =
        trigger.task && typeof trigger.task === "object" && "task" in trigger.task
          ? (trigger.task as { task: string }).task
          : null;
      const taskDescSection = taskDesc ? `\n\nA task has been offered to you:\n"${taskDesc}"` : "";
      const result = await resolveTemplateAsync("task.trigger.offered", {
        review_offered_task_cmd: fmt("review-offered-task"),
        task_id: trigger.taskId,
        task_desc_section: taskDescSection,
      });
      return result.text;
    }

    case "unread_mentions": {
      const result = await resolveTemplateAsync("task.trigger.unread_mentions", {
        mention_count: trigger.count || "unread",
      });
      return result.text;
    }

    case "pool_tasks_available": {
      const result = await resolveTemplateAsync("task.trigger.pool_available", {
        task_count: trigger.count,
      });
      return result.text;
    }

    case "channel_activity": {
      const msgs = (trigger.messages || []) as Array<{
        channelId?: string;
        channelName?: string;
        ts?: string;
        user?: string;
        text?: string;
      }>;
      if (msgs.length === 0) {
        return "New Slack channel activity detected but no message details available. Use `slack-read` to check recent messages.";
      }

      let messagesDetail = "";
      for (const msg of msgs) {
        const channel = msg.channelName ? `#${msg.channelName}` : msg.channelId || "unknown";
        messagesDetail += `- **${channel}** (user: ${msg.user || "unknown"}): ${msg.text?.slice(0, 200) || "(no text)"}\n`;
      }

      const result = await resolveTemplateAsync("task.trigger.channel_activity", {
        message_count: trigger.count || msgs.length,
        messages_detail: messagesDetail,
      });
      return result.text;
    }

    default:
      return defaultPrompt;
  }
}

/** Search agent memories relevant to a task description via the API */
async function fetchRelevantMemories(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  taskDescription: string,
): Promise<string | null> {
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": agentId,
    };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const response = await fetch(`${apiUrl}/api/memory/search`, {
      method: "POST",
      headers,
      body: JSON.stringify({ query: taskDescription, limit: 5 }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      results: Array<{ id: string; name: string; content: string; similarity: number }>;
    };

    const useful = (data.results || []).filter((m) => m.similarity > 0.4);
    if (useful.length === 0) return null;

    const memoryContext = useful
      .map((m) => `- **${m.name}** (id: ${m.id}): ${m.content.substring(0, 300)}`)
      .join("\n");

    return `\n\n### Relevant Past Knowledge\n\nThese memories from your previous sessions may be useful. Use \`memory-get\` with the memory ID to retrieve full details.\n\n${memoryContext}\n`;
  } catch {
    // Non-blocking — don't fail task start because of memory search
    return null;
  }
}

/** Spawn a provider session without blocking - returns immediately with tracking info */
/**
 * Extract a key field from tool arguments for event tracking.
 * Returns a single-entry record with the most identifying arg for the tool.
 */
function extractToolKey(toolName: string, args: unknown): Record<string, string | undefined> {
  const a = args as Record<string, unknown>;
  switch (toolName) {
    case "Read":
    case "Edit":
    case "Write":
      return { filePath: a.file_path as string | undefined };
    case "Bash":
      return { description: a.description as string | undefined };
    case "Grep":
      return { pattern: a.pattern as string | undefined };
    case "Glob":
      return { pattern: a.pattern as string | undefined };
    case "Skill":
      return { skillName: a.skill as string | undefined };
    case "Agent":
      return { description: a.description as string | undefined };
    default:
      return {};
  }
}

async function spawnProviderProcess(
  adapter: ReturnType<typeof createProviderAdapter>,
  opts: {
    prompt: string;
    logFile: string;
    systemPrompt?: string;
    additionalArgs?: string[];
    role: string;
    apiUrl: string;
    apiKey: string;
    agentId: string;
    runnerSessionId: string;
    iteration: number;
    taskId?: string;
    model?: string;
    cwd?: string;
  },
  logDir: string,
  isYolo: boolean,
): Promise<RunningTask> {
  // Real task ID from DB (may be undefined for pool_tasks_available triggers)
  const realTaskId = opts.taskId;
  // Correlation ID for logs/display — always defined
  const effectiveTaskId = realTaskId || crypto.randomUUID();

  // Resolve env first so we can use MODEL_OVERRIDE from config
  const { env: freshEnv, credentialSelections } = await fetchResolvedEnv(
    opts.apiUrl,
    opts.apiKey,
    opts.agentId,
  );

  // Report which key was selected for this task (fire-and-forget)
  if (credentialSelections.length > 0 && realTaskId) {
    for (const sel of credentialSelections) {
      reportKeyUsage(opts.apiUrl, opts.apiKey, sel.keyType, sel, realTaskId).catch(() => {});
    }
  }

  // Propagate agent-fs config to process.env so getBasePrompt() can read them
  // (fetchResolvedEnv returns a new object, doesn't update process.env)
  if (freshEnv.AGENT_FS_SHARED_ORG_ID) {
    process.env.AGENT_FS_SHARED_ORG_ID = freshEnv.AGENT_FS_SHARED_ORG_ID as string;
  }

  const model = opts.model || (freshEnv.MODEL_OVERRIDE as string) || "";

  const config: ProviderSessionConfig = {
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt || "",
    model,
    role: opts.role,
    agentId: opts.agentId,
    taskId: effectiveTaskId,
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    cwd: opts.cwd || process.cwd(),
    logFile: opts.logFile,
    additionalArgs: opts.additionalArgs,
    iteration: opts.iteration,
    env: freshEnv as Record<string, string>,
  };

  const session = await adapter.createSession(config);

  // Set up log streaming
  const logBuffer: LogBuffer = { lines: [], lastFlush: Date.now(), partialLine: "" };
  const shouldStream = opts.apiUrl && opts.runnerSessionId && opts.iteration;

  // Event buffer (flushes to API periodically)
  interface BufferedEvent {
    category: string;
    event: string;
    status?: string;
    source: string;
    agentId?: string;
    taskId?: string;
    sessionId?: string;
    parentEventId?: string;
    numericValue?: number;
    durationMs?: number;
    data?: Record<string, unknown>;
  }

  const eventBuffer: BufferedEvent[] = [];
  const EVENT_FLUSH_INTERVAL_MS = 5000;
  const EVENT_BUFFER_MAX = 50;

  function bufferEvent(evt: BufferedEvent) {
    eventBuffer.push(evt);
    if (eventBuffer.length >= EVENT_BUFFER_MAX) {
      flushEvents();
    }
  }

  async function flushEvents() {
    if (eventBuffer.length === 0) return;
    const batch = eventBuffer.splice(0);
    try {
      await fetch(`${opts.apiUrl}/api/events/batch`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${opts.apiKey}`,
          "X-Agent-ID": opts.agentId,
        },
        body: JSON.stringify({ events: batch }),
      });
    } catch {
      // Non-blocking — event loss is acceptable
    }
  }

  const eventFlushTimer = setInterval(flushEvents, EVENT_FLUSH_INTERVAL_MS);
  const sessionStartTime = Date.now();

  // Auto-progress throttle: don't update more than once per 3 seconds
  let lastProgressTime = 0;
  const PROGRESS_THROTTLE_MS = 3000;

  // Context usage throttle: max 1 snapshot per 30 seconds
  let lastContextPostTime = 0;
  const CONTEXT_THROTTLE_MS = 30_000;

  session.onEvent((event) => {
    switch (event.type) {
      case "session_init":
        if (realTaskId) {
          saveProviderSessionId(opts.apiUrl, opts.apiKey, realTaskId, event.sessionId).catch(
            (err) => console.warn(`[runner] Failed to save session ID: ${err}`),
          );
        } else {
          // Pool task: save provider session ID on active session so it can be
          // propagated to the real task when the agent claims one
          saveProviderSessionIdOnActiveSession(
            opts.apiUrl,
            opts.apiKey,
            effectiveTaskId,
            event.sessionId,
          ).catch((err) =>
            console.warn(`[runner] Failed to save provider session on active session: ${err}`),
          );
        }

        // Buffer session start event
        bufferEvent({
          category: "session",
          event: "session.start",
          source: "worker",
          agentId: opts.agentId,
          taskId: effectiveTaskId,
          sessionId: event.sessionId,
        });
        break;
      case "tool_start": {
        // Auto-progress: report tool activity as task progress (throttled)
        const now = Date.now();
        if (effectiveTaskId && opts.apiUrl && now - lastProgressTime >= PROGRESS_THROTTLE_MS) {
          const progress = toolCallToProgress(event.toolName, event.args);
          if (progress) {
            lastProgressTime = now;
            updateProgressViaAPI(opts.apiUrl, opts.apiKey, effectiveTaskId, progress).catch(
              () => {},
            );
          }
        }

        // Buffer tool event
        bufferEvent({
          category: "tool",
          event: "tool.start",
          source: "worker",
          agentId: opts.agentId,
          taskId: effectiveTaskId,
          sessionId: opts.runnerSessionId,
          data: {
            toolName: event.toolName,
            toolCallId: event.toolCallId,
            ...extractToolKey(event.toolName, event.args),
            clientTimestamp: new Date().toISOString(),
          },
        });

        // Also emit skill event when tool is Skill
        if (event.toolName === "Skill") {
          const args = event.args as Record<string, unknown>;
          bufferEvent({
            category: "skill",
            event: "skill.invoke",
            source: "worker",
            agentId: opts.agentId,
            taskId: effectiveTaskId,
            sessionId: opts.runnerSessionId,
            data: {
              skillName: args.skill as string,
              clientTimestamp: new Date().toISOString(),
            },
          });
        }
        break;
      }
      case "result":
        // Cost save is handled in waitForCompletion().then() to ensure
        // it completes before the process exits (fire-and-forget here
        // races with container shutdown).

        // Buffer session end event
        bufferEvent({
          category: "session",
          event: "session.end",
          source: "worker",
          agentId: opts.agentId,
          taskId: effectiveTaskId,
          sessionId: opts.runnerSessionId,
          status: event.isError ? "error" : "ok",
          durationMs: Date.now() - sessionStartTime,
          data: {
            model: event.cost.model,
            totalCostUsd: event.cost.totalCostUsd,
            inputTokens: event.cost.inputTokens,
            outputTokens: event.cost.outputTokens,
          },
        });
        break;
      case "context_usage": {
        const now2 = Date.now();
        if (now2 - lastContextPostTime >= CONTEXT_THROTTLE_MS) {
          lastContextPostTime = now2;
          fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Agent-ID": opts.agentId,
              Authorization: `Bearer ${opts.apiKey}`,
            },
            body: JSON.stringify({
              eventType: "progress",
              sessionId: opts.runnerSessionId,
              contextUsedTokens: event.contextUsedTokens,
              contextTotalTokens: event.contextTotalTokens,
              contextPercent: event.contextPercent,
            }),
          }).catch(() => {});
        }
        break;
      }
      case "compaction": {
        // Always record compaction events (no throttle)
        fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Agent-ID": opts.agentId,
            Authorization: `Bearer ${opts.apiKey}`,
          },
          body: JSON.stringify({
            eventType: "compaction",
            sessionId: opts.runnerSessionId,
            preCompactTokens: event.preCompactTokens,
            compactTrigger: event.compactTrigger,
            contextTotalTokens: event.contextTotalTokens,
          }),
        }).catch(() => {});
        break;
      }
      case "raw_log":
        prettyPrintLine(event.content, opts.role);
        if (shouldStream) {
          logBuffer.lines.push(event.content);
          const shouldFlush =
            logBuffer.lines.length >= LOG_BUFFER_SIZE ||
            Date.now() - logBuffer.lastFlush >= LOG_FLUSH_INTERVAL_MS;
          if (shouldFlush) {
            flushLogBuffer(logBuffer, {
              apiUrl: opts.apiUrl,
              apiKey: opts.apiKey,
              agentId: opts.agentId,
              sessionId: opts.runnerSessionId,
              iteration: opts.iteration,
              taskId: effectiveTaskId,
              cli: adapter.name,
            }).catch(() => {});
          }
        }
        break;
      case "raw_stderr":
        prettyPrintStderr(event.content, opts.role);
        break;
    }
  });

  // Create promise that handles completion
  const promise: Promise<ProviderResult> = session.waitForCompletion().then(async (result) => {
    // Stop event flush timer and do a final flush
    clearInterval(eventFlushTimer);
    await flushEvents();

    // Final log flush
    if (shouldStream && logBuffer.lines.length > 0) {
      await flushLogBuffer(logBuffer, {
        apiUrl: opts.apiUrl,
        apiKey: opts.apiKey,
        agentId: opts.agentId,
        sessionId: opts.runnerSessionId,
        iteration: opts.iteration,
        taskId: effectiveTaskId,
        cli: adapter.name,
      });
    }

    // Error logging for non-zero exit
    if (result.exitCode !== 0) {
      const errorLog = {
        timestamp: new Date().toISOString(),
        iteration: opts.iteration,
        exitCode: result.exitCode,
        taskId: effectiveTaskId,
        error: true,
      };

      const errorsFile = `${logDir}/errors.jsonl`;
      const errorsFileRef = Bun.file(errorsFile);
      const existingErrors = (await errorsFileRef.exists()) ? await errorsFileRef.text() : "";
      await Bun.write(errorsFile, `${existingErrors}${JSON.stringify(errorLog)}\n`);

      if (!isYolo) {
        console.error(
          `[${opts.role}] Task ${effectiveTaskId.slice(0, 8)} exited with code ${result.exitCode}.`,
        );
      } else {
        console.warn(
          `[${opts.role}] Task ${effectiveTaskId.slice(0, 8)} exited with code ${result.exitCode}. YOLO mode - continuing...`,
        );
      }
    }

    // Save cost data (awaited to ensure it completes before container exits)
    if (result.cost) {
      try {
        await saveCostData(
          { ...result.cost, taskId: realTaskId, sessionId: opts.runnerSessionId },
          opts.apiUrl,
          opts.apiKey,
        );
      } catch (err) {
        console.warn(`[runner] Failed to save cost: ${err}`);
      }
    }

    // Post completion context usage snapshot
    if (result.cost && realTaskId) {
      fetch(`${opts.apiUrl}/api/tasks/${realTaskId}/context`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Agent-ID": opts.agentId,
          Authorization: `Bearer ${opts.apiKey}`,
        },
        body: JSON.stringify({
          eventType: "completion",
          sessionId: opts.runnerSessionId,
          cumulativeInputTokens: result.cost.inputTokens ?? 0,
          cumulativeOutputTokens: result.cost.outputTokens ?? 0,
          contextTotalTokens: getContextWindowSize(result.cost.model || "default"),
        }),
      }).catch(() => {});
    }

    return result;
  });

  // Build credential info for rate limit tracking
  const primarySelection = credentialSelections[0];
  const credentialInfo = primarySelection
    ? {
        keyType: primarySelection.keyType,
        keySuffix: primarySelection.keySuffix,
        keyIndex: primarySelection.index,
      }
    : undefined;

  const runningTask: RunningTask = {
    taskId: effectiveTaskId,
    session,
    logFile: opts.logFile,
    startTime: new Date(),
    promise,
    result: null,
    credentialInfo,
  };

  // Non-blocking completion tracking
  promise
    .then((r) => {
      runningTask.result = r;
    })
    .catch(() => {
      runningTask.result = { exitCode: 1, isError: true };
    });

  return runningTask;
}

/** Run a single provider iteration (blocking) - used for AI-loop mode */
async function runProviderIteration(
  adapter: ReturnType<typeof createProviderAdapter>,
  opts: {
    prompt: string;
    logFile: string;
    systemPrompt?: string;
    additionalArgs?: string[];
    role: string;
    apiUrl: string;
    apiKey: string;
    agentId: string;
    taskId?: string;
    cwd?: string;
  },
): Promise<ProviderResult> {
  const { env: freshEnv } = await fetchResolvedEnv(opts.apiUrl, opts.apiKey, opts.agentId);
  const model = (freshEnv.MODEL_OVERRIDE as string) || "";

  const config: ProviderSessionConfig = {
    prompt: opts.prompt,
    systemPrompt: opts.systemPrompt || "",
    model,
    role: opts.role,
    agentId: opts.agentId,
    taskId: opts.taskId || crypto.randomUUID(),
    apiUrl: opts.apiUrl,
    apiKey: opts.apiKey,
    cwd: opts.cwd || process.cwd(),
    logFile: opts.logFile,
    additionalArgs: opts.additionalArgs,
    env: freshEnv as Record<string, string>,
  };

  const session = await adapter.createSession(config);

  session.onEvent((event) => {
    if (event.type === "raw_log") prettyPrintLine(event.content, opts.role);
    if (event.type === "raw_stderr") prettyPrintStderr(event.content, opts.role);
    if (event.type === "session_init" && opts.taskId) {
      saveProviderSessionId(opts.apiUrl, opts.apiKey, opts.taskId, event.sessionId).catch((err) =>
        console.warn(`[runner] Failed to save session ID: ${err}`),
      );
    }
  });

  return session.waitForCompletion();
}

/** Check for completed processes and remove them from active tasks */
async function checkCompletedProcesses(
  state: RunnerState,
  role: string,
  apiConfig?: ApiConfig,
): Promise<void> {
  const completedTasks: Array<{
    taskId: string;
    result: ProviderResult;
    triggerType?: string;
    cursorUpdates?: Array<{ channelId: string; ts: string }>;
    workingDir?: string;
    credentialInfo?: RunningTask["credentialInfo"];
  }> = [];

  for (const [taskId, task] of state.activeTasks) {
    // Non-blocking check: result is set by a .then() callback when the promise resolves
    if (task.result !== null) {
      console.log(
        `[${role}] Task ${taskId.slice(0, 8)} completed with exit code ${task.result.exitCode} (trigger: ${task.triggerType || "unknown"})`,
      );
      completedTasks.push({
        taskId,
        result: task.result,
        triggerType: task.triggerType,
        cursorUpdates: task.cursorUpdates,
        workingDir: task.workingDir,
        credentialInfo: task.credentialInfo,
      });
    }
  }

  // Remove completed tasks from the map and ensure they're marked as finished
  for (const { taskId, result, cursorUpdates, workingDir, credentialInfo } of completedTasks) {
    state.activeTasks.delete(taskId);

    if (apiConfig) {
      removeActiveSession(apiConfig, taskId);
    }

    // Detect VCS before finishing — last chance to link a PR
    if (apiConfig && workingDir && !vcsDetectedTasks.has(taskId)) {
      await detectVcsForTask(apiConfig.apiUrl, apiConfig.apiKey, taskId, workingDir);
    }

    // Call the finish API to ensure task status is updated
    // This is idempotent - if the agent already marked it, this is a no-op
    if (apiConfig) {
      let failureReason: string | undefined;
      if (result.exitCode !== 0 && result.failureReason) {
        failureReason = result.failureReason;
        console.log(`[${role}] Detected error for task ${taskId.slice(0, 8)}: ${failureReason}`);

        // If rate-limited and we know which key was used, report it
        if (credentialInfo && /rate.?limit/i.test(failureReason)) {
          // Try to extract reset time from the error message (e.g. "resets 3pm (UTC)")
          const parsedResetTime = parseRateLimitResetTime(failureReason);
          const defaultCooldownMs = 5 * 60 * 1000;
          const rateLimitedUntil =
            parsedResetTime ?? new Date(Date.now() + defaultCooldownMs).toISOString();
          if (parsedResetTime) {
            console.log(
              `[credentials] Parsed rate limit reset time from error: ${parsedResetTime}`,
            );
          }
          reportKeyRateLimit(
            apiConfig.apiUrl,
            apiConfig.apiKey,
            credentialInfo.keyType,
            credentialInfo.keySuffix,
            credentialInfo.keyIndex,
            rateLimitedUntil,
          ).catch(() => {});
        }
      }
      await ensureTaskFinished(apiConfig, role, taskId, result.exitCode, failureReason);

      ensure({
        id: "worker_process_finished",
        flow: "task",
        runId: taskId,
        depIds: ["worker_process_spawned"],
        data: {
          taskId,
          agentId: apiConfig.agentId,
          role,
          exitCode: result.exitCode,
          success: result.exitCode === 0,
          failureReason,
        },
        validator: (data) => data.exitCode === 0,
        // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
        filter: ({}, ctx) => ctx.deps.length > 0,
        conditions: [{ timeout_ms: 3_600_000 }], // 1 hour: process runtime
      });

      // Commit channel activity cursors after successful processing
      // If the task failed, cursors stay uncommitted so messages are re-seen on next poll
      if (cursorUpdates && cursorUpdates.length > 0 && result.exitCode === 0) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (apiConfig.apiKey) headers.Authorization = `Bearer ${apiConfig.apiKey}`;
          await fetch(`${apiConfig.apiUrl}/api/channel-activity/commit-cursors`, {
            method: "POST",
            headers,
            body: JSON.stringify({ cursorUpdates }),
          });
          console.log(
            `[${role}] Committed ${cursorUpdates.length} channel activity cursor(s) for task ${taskId.slice(0, 8)}`,
          );
        } catch (err) {
          console.warn(`[${role}] Failed to commit channel activity cursors: ${err}`);
        }
      }
    }
  }
}

const TEMPLATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

async function fetchTemplate(
  templateId: string,
  registryUrl: string,
  cacheDir: string,
): Promise<TemplateResponse | null> {
  const safeId = templateId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const cachePath = `${cacheDir}/${safeId}.json`;

  // Check local cache
  try {
    const info = await stat(cachePath);
    if (Date.now() - info.mtimeMs < TEMPLATE_CACHE_TTL_MS) {
      const cached = await readFile(cachePath, "utf-8");
      return JSON.parse(cached) as TemplateResponse;
    }
  } catch {
    // No cache or expired, continue to fetch
  }

  // Fetch from registry
  try {
    const resp = await fetch(`${registryUrl}/api/templates/${templateId}`);
    if (!resp.ok) {
      console.warn(`[template] Registry returned ${resp.status} for ${templateId}`);
      // Fall back to expired cache if available
      try {
        const cached = await readFile(cachePath, "utf-8");
        console.log(`[template] Using expired cache for ${templateId}`);
        return JSON.parse(cached) as TemplateResponse;
      } catch {
        return null;
      }
    }

    const template = (await resp.json()) as TemplateResponse;

    // Cache the response
    try {
      await mkdir(cacheDir, { recursive: true });
      await writeFile(cachePath, JSON.stringify(template), "utf-8");
    } catch {
      console.warn(`[template] Could not cache template to ${cachePath}`);
    }

    return template;
  } catch (err) {
    console.warn(`[template] Failed to fetch from registry: ${err}`);
    // Fall back to expired cache
    try {
      const cached = await readFile(cachePath, "utf-8");
      console.log(`[template] Using expired cache for ${templateId}`);
      return JSON.parse(cached) as TemplateResponse;
    } catch {
      return null;
    }
  }
}

export async function runAgent(config: RunnerConfig, opts: RunnerOptions) {
  const { defaultPrompt, metadataType } = config;
  let role = config.role;

  // Initialize Business-Use SDK for worker-side instrumentation
  initialize();

  // Create provider adapter based on HARNESS_PROVIDER env var (default: claude)
  const adapter = createProviderAdapter(process.env.HARNESS_PROVIDER || "claude");

  const sessionId = process.env.SESSION_ID || crypto.randomUUID().slice(0, 8);
  const baseLogDir = opts.logsDir || process.env.LOG_DIR || "/logs";
  const logDir = `${baseLogDir}/${sessionId}`;

  await mkdir(logDir, { recursive: true });

  const prompt = opts.prompt || defaultPrompt;
  const isYolo = opts.yolo || process.env.YOLO === "true";

  // Get agent identity and swarm URL for base prompt
  const agentId = process.env.AGENT_ID || "unknown";

  const apiUrl = process.env.MCP_BASE_URL || `http://localhost:${process.env.PORT || "3013"}`;
  const swarmUrl = process.env.SWARM_URL || "localhost";

  // Configure HTTP-based template resolution (workers resolve via API, not local DB)
  if (process.env.API_KEY) {
    configureHttpResolver(apiUrl, process.env.API_KEY);
  }

  let capabilities = config.capabilities;

  // Agent identity fields — populated after registration by fetching full profile
  let agentSoulMd: string | undefined;
  let agentIdentityMd: string | undefined;
  let agentSetupScript: string | undefined;
  let agentToolsMd: string | undefined;
  let agentClaudeMd: string | undefined;
  let agentHeartbeatMd: string | undefined;
  let agentProfileName: string | undefined;
  let agentDescription: string | undefined;
  let agentSkillsSummary: { name: string; description: string }[] | undefined;
  let agentMcpServersSummary: string | undefined;

  // Per-task repo context — set when processing a task with githubRepo
  let currentRepoContext: BasePromptArgs["repoContext"] | undefined;

  // Generate base prompt (identity fields injected after profile fetch below)
  const buildSystemPrompt = async () => {
    return getBasePrompt({
      role,
      agentId,
      swarmUrl,
      capabilities,
      name: agentProfileName,
      description: agentDescription,
      soulMd: agentSoulMd,
      identityMd: agentIdentityMd,
      toolsMd: agentToolsMd,
      claudeMd: agentClaudeMd,
      repoContext: currentRepoContext,
      skillsSummary: agentSkillsSummary,
      mcpServersSummary: agentMcpServersSummary,
    });
  };

  let basePrompt = await buildSystemPrompt();

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
    // Fetch template early (before registration) so defaults can be applied
    const templateId = process.env.TEMPLATE_ID;
    const registryUrl = process.env.TEMPLATE_REGISTRY_URL || "https://templates.agent-swarm.dev";
    let cachedTemplate: TemplateResponse | null = null;

    if (templateId) {
      try {
        cachedTemplate = await fetchTemplate(templateId, registryUrl, "/workspace/.template-cache");
        if (cachedTemplate) {
          console.log(`[${role}] Fetched template: ${templateId}`);

          // Apply agentDefaults as fallbacks (env/config takes precedence)
          const defaults = cachedTemplate.config.agentDefaults;
          if (config.role === "worker" && defaults.role) {
            role = defaults.role;
          }
          if (!capabilities?.length && defaults.capabilities?.length) {
            capabilities = defaults.capabilities;
          }
        }
      } catch (err) {
        console.warn(`[${role}] Failed to fetch template ${templateId}: ${err}`);
      }
    }

    // Runner-level polling mode with parallel execution support
    const isLeadFromConfig = config.role === "lead";
    const isLead = isLeadFromConfig || (cachedTemplate?.config.agentDefaults?.isLead ?? false);
    const defaultMaxTasks = isLead ? 2 : 1;
    const maxConcurrent = process.env.MAX_CONCURRENT_TASKS
      ? parseInt(process.env.MAX_CONCURRENT_TASKS, 10)
      : (cachedTemplate?.config.agentDefaults?.maxTasks ?? defaultMaxTasks);
    console.log(`[${role}] Mode: runner-level polling (use --ai-loop for AI-based polling)`);
    console.log(`[${role}] Max concurrent tasks: ${maxConcurrent}`);

    // Initialize runner state for parallel execution
    const state: RunnerState = {
      activeTasks: new Map(),
      maxConcurrent,
    };

    // Track tasks already signaled for cancellation to avoid repeated SIGTERM
    const cancelledSignaled = new Set<string>();

    // Create API config for ping/close
    const apiConfig: ApiConfig = { apiUrl, apiKey, agentId };

    // Setup graceful shutdown handlers with API config and runner state access
    setupShutdownHandlers(role, apiConfig, () => state);

    // Register agent before starting
    const agentName =
      process.env.AGENT_NAME ||
      cachedTemplate?.config.displayName ||
      `${role}-${agentId.slice(0, 8)}`;
    try {
      await registerAgent({
        apiUrl,
        apiKey,
        agentId,
        name: agentName,
        role,
        isLead,
        capabilities,
        maxTasks: maxConcurrent,
      });
      console.log(`[${role}] Registered as "${agentName}" (ID: ${agentId})`);
    } catch (error) {
      console.error(`[${role}] Failed to register: ${error}`);
      process.exit(1);
    }

    // Clean up any stale active sessions from previous runs (crash recovery)
    await cleanupActiveSessions(apiConfig);
    console.log(`[${role}] Cleaned up stale active sessions`);

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
          heartbeatMd?: string;
          name?: string;
          description?: string;
        };
        agentSoulMd = profile.soulMd;
        agentIdentityMd = profile.identityMd;
        agentSetupScript = profile.setupScript;
        agentToolsMd = profile.toolsMd;
        agentClaudeMd = profile.claudeMd;
        agentHeartbeatMd = profile.heartbeatMd;
        agentProfileName = profile.name;
        agentDescription = profile.description;

        // Generate default templates if missing (runner registers via POST /api/agents
        // which doesn't generate templates like join-swarm does)
        if (
          !agentSoulMd ||
          !agentIdentityMd ||
          !agentToolsMd ||
          !agentClaudeMd ||
          !agentHeartbeatMd
        ) {
          // Use already-fetched template (from pre-registration step)
          if (cachedTemplate) {
            const ctx = {
              agent: {
                name: agentProfileName || agentName,
                role: role,
                description: agentDescription || "",
                capabilities: (capabilities || []).join(", "),
              },
            };
            if (!agentSoulMd) agentSoulMd = interpolate(cachedTemplate.files.soulMd, ctx).result;
            if (!agentIdentityMd)
              agentIdentityMd = interpolate(cachedTemplate.files.identityMd, ctx).result;
            if (!agentToolsMd) agentToolsMd = interpolate(cachedTemplate.files.toolsMd, ctx).result;
            if (!agentClaudeMd)
              agentClaudeMd = interpolate(cachedTemplate.files.claudeMd, ctx).result;
            if (!agentSetupScript)
              agentSetupScript = interpolate(cachedTemplate.files.setupScript, ctx).result;
            if (!agentHeartbeatMd)
              agentHeartbeatMd = interpolate(cachedTemplate.files.heartbeatMd, ctx).result;
            console.log(`[${role}] Applied template: ${templateId}`);
          }

          // Fallback to generic defaults for any still-missing fields
          const agentInfo = {
            name: agentProfileName || agentName,
            role: role,
            description: agentDescription,
            capabilities: config.capabilities,
          };
          if (!agentSoulMd) agentSoulMd = generateDefaultSoulMd(agentInfo);
          if (!agentIdentityMd) agentIdentityMd = generateDefaultIdentityMd(agentInfo);
          if (!agentToolsMd) agentToolsMd = generateDefaultToolsMd(agentInfo);
          if (!agentClaudeMd) agentClaudeMd = generateDefaultClaudeMd(agentInfo);

          // Push generated templates to server
          try {
            const profileUpdate: Record<string, string> = {};
            if (!profile.soulMd) profileUpdate.soulMd = agentSoulMd;
            if (!profile.identityMd) profileUpdate.identityMd = agentIdentityMd;
            if (!profile.toolsMd) profileUpdate.toolsMd = agentToolsMd;
            if (!profile.claudeMd && agentClaudeMd) profileUpdate.claudeMd = agentClaudeMd;
            if (!profile.setupScript && agentSetupScript)
              profileUpdate.setupScript = agentSetupScript;
            if (!profile.heartbeatMd && agentHeartbeatMd)
              profileUpdate.heartbeatMd = agentHeartbeatMd;

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

        // Fetch installed skills for system prompt
        try {
          const skillsResp = await fetch(`${apiUrl}/api/agents/${agentId}/skills`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Agent-ID": agentId,
            },
          });
          if (skillsResp.ok) {
            const skillsData = (await skillsResp.json()) as {
              skills: {
                name: string;
                description: string;
                isActive: boolean;
                isEnabled: boolean;
              }[];
            };
            agentSkillsSummary = skillsData.skills
              .filter((s) => s.isActive && s.isEnabled)
              .map((s) => ({ name: s.name, description: s.description }));
            if (agentSkillsSummary.length > 0) {
              console.log(`[${role}] Loaded ${agentSkillsSummary.length} skills for system prompt`);
            }
          }
        } catch {
          // Non-fatal — skills are optional
        }

        // Fetch installed MCP servers for system prompt
        try {
          const mcpServersResp = await fetch(`${apiUrl}/api/agents/${agentId}/mcp-servers`, {
            headers: {
              Authorization: `Bearer ${apiKey}`,
              "X-Agent-ID": agentId,
            },
          });
          if (mcpServersResp.ok) {
            const mcpServersData = (await mcpServersResp.json()) as {
              servers: {
                name: string;
                transport: string;
                description: string | null;
                isActive: boolean;
                isEnabled: boolean;
              }[];
            };
            const activeMcpServers = mcpServersData.servers.filter(
              (s) => s.isActive && s.isEnabled,
            );
            if (activeMcpServers.length > 0) {
              agentMcpServersSummary = activeMcpServers
                .map(
                  (s) => `- **${s.name}** (${s.transport}): ${s.description || "No description"}`,
                )
                .join("\n");
              console.log(
                `[${role}] Loaded ${activeMcpServers.length} MCP servers for system prompt`,
              );
            }
          }
        } catch {
          // Non-fatal — MCP servers are optional
        }

        // Rebuild system prompt with identity
        basePrompt = await buildSystemPrompt();
        resolvedSystemPrompt = additionalSystemPrompt
          ? `${basePrompt}\n\n${additionalSystemPrompt}`
          : basePrompt;
        console.log(
          `[${role}] Loaded agent identity (soul: ${agentSoulMd ? "yes" : "no"}, identity: ${agentIdentityMd ? "yes" : "no"}, tools: ${agentToolsMd ? "yes" : "no"}, claude: ${agentClaudeMd ? "yes" : "no"})`,
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

    // Write HEARTBEAT.md to workspace (lead's periodic checklist)
    if (agentHeartbeatMd) {
      try {
        await Bun.write("/workspace/HEARTBEAT.md", agentHeartbeatMd);
        console.log(`[${role}] Wrote HEARTBEAT.md to workspace`);
      } catch (err) {
        console.warn(`[${role}] Could not write HEARTBEAT.md: ${(err as Error).message}`);
      }
    }

    // Write CLAUDE.md to workspace (agent-level instructions)
    if (agentClaudeMd) {
      try {
        await Bun.write("/workspace/CLAUDE.md", agentClaudeMd);
        console.log(`[${role}] Wrote CLAUDE.md to workspace`);
      } catch (err) {
        console.warn(`[${role}] Could not write CLAUDE.md: ${(err as Error).message}`);
      }
    }

    // ========== Sync skills to filesystem ==========
    try {
      console.log(`[${role}] Syncing skills to filesystem...`);
      const syncHeaders: Record<string, string> = {
        "Content-Type": "application/json",
        "X-Agent-ID": agentId,
      };
      if (apiKey) syncHeaders.Authorization = `Bearer ${apiKey}`;
      const syncRes = await fetch(`${swarmUrl}/api/skills/sync-filesystem`, {
        method: "POST",
        headers: syncHeaders,
      });
      if (syncRes.ok) {
        const syncResult = (await syncRes.json()) as {
          synced: number;
          removed: number;
          errors: string[];
        };
        console.log(
          `[${role}] Skills synced: ${syncResult.synced} written, ${syncResult.removed} removed`,
        );
        if (syncResult.errors.length > 0) {
          console.warn(`[${role}] Skill sync errors: ${syncResult.errors.join(", ")}`);
        }
      } else {
        console.warn(`[${role}] Skill sync failed: HTTP ${syncRes.status}`);
      }
    } catch (err) {
      console.warn(`[${role}] Skill sync failed: ${(err as Error).message}`);
    }

    // ========== Resume paused tasks with PRIORITY ==========
    // Check for paused tasks from previous shutdown and resume them before normal polling
    try {
      console.log(`[${role}] Checking for paused tasks to resume...`);
      const pausedTasks = await getPausedTasksFromAPI(apiConfig);

      if (pausedTasks.length > 0) {
        console.log(`[${role}] Found ${pausedTasks.length} paused task(s) to resume`);

        for (const task of pausedTasks) {
          // Defensive: skip tasks that already have completion data (zombie prevention)
          if (task.finishedAt || task.output) {
            console.warn(
              `[${role}] Skipping zombie task ${task.id.slice(0, 8)} — already has completion data (finishedAt: ${!!task.finishedAt}, output: ${!!task.output})`,
            );
            continue;
          }

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

          // Build prompt with resume context + memory injection
          let resumePrompt = await buildResumePrompt(task, adapter.formatCommand.bind(adapter));

          // Inject relevant memories for resumed tasks
          const resumeMemoryContext = await fetchRelevantMemories(
            apiUrl,
            apiKey,
            agentId,
            task.task,
          );
          if (resumeMemoryContext) {
            resumePrompt += resumeMemoryContext;
            console.log(`[${role}] Injected relevant memories into resumed task prompt`);
          }

          // Resolve --resume: prefer own session ID, then parent's
          let resumeAdditionalArgs = opts.additionalArgs || [];
          if (task.claudeSessionId) {
            resumeAdditionalArgs = [...resumeAdditionalArgs, "--resume", task.claudeSessionId];
            console.log(
              `[${role}] Resuming task's own session ${task.claudeSessionId.slice(0, 8)}`,
            );
          } else if (task.parentTaskId) {
            const parentSessionId = await fetchProviderSessionId(apiUrl, apiKey, task.parentTaskId);
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

          // Resolve cwd for resumed task (mirrors normal task path: task.dir > vcsRepo clonePath)
          let resumeCwd: string | undefined;
          if (task.dir) {
            try {
              if (existsSync(task.dir) && statSync(task.dir).isDirectory()) {
                resumeCwd = task.dir;
              } else {
                console.warn(
                  `[${role}] Resume task dir "${task.dir}" does not exist or is not a directory, falling back to default cwd`,
                );
              }
            } catch {
              console.warn(
                `[${role}] Failed to check resume task dir "${task.dir}", falling back to default cwd`,
              );
            }
          }

          if (!resumeCwd && task.vcsRepo && apiUrl) {
            const repoConfig = await fetchRepoConfig(apiUrl, apiKey, task.vcsRepo);
            const effectiveConfig = repoConfig ?? {
              url: task.vcsRepo,
              name: task.vcsRepo.split("/").pop() || task.vcsRepo,
              clonePath: `/workspace/repos/${task.vcsRepo.split("/").pop() || task.vcsRepo}`,
              defaultBranch: "main",
            };
            const repoContext = await ensureRepoForTask(effectiveConfig, role);
            if (repoContext?.clonePath) {
              resumeCwd = repoContext.clonePath;
            }
          }

          // Per-task runner session ID so session logs are scoped to this task
          const resumeRunnerSessionId = crypto.randomUUID();

          let runningTask: RunningTask;
          try {
            runningTask = await spawnProviderProcess(
              adapter,
              {
                prompt: resumePrompt,
                logFile,
                systemPrompt: resolvedSystemPrompt,
                additionalArgs: resumeAdditionalArgs,
                role,
                apiUrl,
                apiKey,
                agentId,
                runnerSessionId: resumeRunnerSessionId,
                iteration,
                taskId: task.id,
                model: (task as { model?: string }).model,
                cwd: resumeCwd,
              },
              logDir,
              isYolo,
            );
          } catch (spawnErr) {
            const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            console.error(
              `[${role}] Failed to spawn process for resumed task ${task.id.slice(0, 8)}: ${errMsg}`,
            );
            await ensureTaskFinished(apiConfig, role, task.id, 1, `Spawn failed: ${errMsg}`);
            continue;
          }

          state.activeTasks.set(task.id, runningTask);
          registerActiveSession(apiConfig, {
            taskId: task.id,
            triggerType: "task_resumed",
            taskDescription: task.task?.slice(0, 200),
            runnerSessionId: resumeRunnerSessionId,
          });
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

    // ========== Lead startup self-check ==========
    if (isLead) {
      console.log(`[${role}] Running startup heartbeat sweep...`);
      const swept = await triggerHeartbeatSweep(apiConfig);
      if (swept) {
        console.log(`[${role}] Startup heartbeat sweep completed`);
      } else {
        console.warn(`[${role}] Startup heartbeat sweep failed (non-fatal)`);
      }
    }

    // Track last finished task check for leads (to avoid re-processing)
    while (true) {
      // Ping server on each iteration to keep status updated
      await pingServer(apiConfig, role);

      // Check for completed processes first and ensure tasks are marked as finished
      await checkCompletedProcesses(state, role, apiConfig);

      // Periodic VCS detection for running tasks (fire-and-forget, throttled per task)
      const now = Date.now();
      for (const [taskId, task] of state.activeTasks) {
        if (vcsDetectedTasks.has(taskId)) continue;
        const lastCheck = vcsCheckTimestamps.get(taskId) ?? 0;
        if (now - lastCheck < VCS_CHECK_INTERVAL) continue;
        if (!task.workingDir) continue;

        vcsCheckTimestamps.set(taskId, now);
        detectVcsForTask(apiUrl, apiKey, taskId, task.workingDir);
      }

      // Check for cancelled tasks and signal their subprocesses
      if (state.activeTasks.size > 0) {
        for (const [taskId, task] of state.activeTasks) {
          if (cancelledSignaled.has(taskId)) continue; // Already sent SIGTERM
          try {
            const cancelResp = await fetch(
              `${apiUrl}/cancelled-tasks?taskId=${encodeURIComponent(taskId)}`,
              {
                headers: {
                  Authorization: `Bearer ${apiKey}`,
                  "X-Agent-ID": agentId,
                },
              },
            );
            if (cancelResp.ok) {
              const cancelData = (await cancelResp.json()) as {
                cancelled: Array<{ id: string }>;
              };
              if (cancelData.cancelled?.some((t) => t.id === taskId)) {
                console.log(
                  `[${role}] Task ${taskId.slice(0, 8)} was cancelled — sending SIGTERM to subprocess`,
                );
                task.session.abort().catch(() => {});
                cancelledSignaled.add(taskId);
              }
            }
          } catch {
            // Non-blocking — cancellation check is best-effort
          }
        }
      }

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
        });

        if (trigger) {
          console.log(`[${role}] Trigger received: ${trigger.type}`);

          if (
            trigger.taskId &&
            (trigger.type === "task_assigned" || trigger.type === "task_offered")
          ) {
            ensure({
              id: "worker_received",
              flow: "task",
              runId: trigger.taskId,
              depIds: ["started"],
              data: {
                taskId: trigger.taskId,
                agentId,
                triggerType: trigger.type,
                role,
              },
              // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
              filter: ({}, ctx) => ctx.deps.length > 0,
              conditions: [{ timeout_ms: 60_000 }], // 1 min: immediate after poll
            });
          }

          // Build prompt based on trigger
          let triggerPrompt = await buildPromptForTrigger(
            trigger,
            prompt,
            adapter.formatCommand.bind(adapter),
          );

          // Enrich prompt with relevant memories from past sessions
          if (trigger.type === "task_assigned" || trigger.type === "task_offered") {
            const task =
              trigger.task && typeof trigger.task === "object" && "task" in trigger.task
                ? (trigger.task as { task: string; id?: string })
                : null;
            if (task?.task) {
              const memoryContext = await fetchRelevantMemories(apiUrl, apiKey, agentId, task.task);
              if (memoryContext) {
                triggerPrompt += memoryContext;
                console.log(`[${role}] Injected relevant memories into task prompt`);
              }
            }
          }

          // Resolve --resume for child tasks with parentTaskId
          let effectiveAdditionalArgs = opts.additionalArgs || [];
          const taskObj = trigger.task as { parentTaskId?: string } | undefined;
          if (taskObj?.parentTaskId) {
            const parentSessionId = await fetchProviderSessionId(
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

          // Extract model from task data for per-task model selection
          const taskModel = (trigger.task as { model?: string } | undefined)?.model;

          // Handle repo context for tasks with vcsRepo (GitHub/GitLab)
          const taskVcsRepo = (trigger.task as { vcsRepo?: string } | undefined)?.vcsRepo;
          if (taskVcsRepo && apiUrl) {
            const repoConfig = await fetchRepoConfig(apiUrl, apiKey, taskVcsRepo);
            // Fall back to convention-based config if repo is not registered
            const effectiveConfig = repoConfig ?? {
              url: taskVcsRepo,
              name: taskVcsRepo.split("/").pop() || taskVcsRepo,
              clonePath: `/workspace/repos/${taskVcsRepo.split("/").pop() || taskVcsRepo}`,
              defaultBranch: "main",
            };
            currentRepoContext = await ensureRepoForTask(effectiveConfig, role);
          } else {
            currentRepoContext = undefined;
          }

          // Resolve effective working directory (priority: task.dir > repoContext.clonePath > process.cwd())
          const taskDir = (trigger.task as { dir?: string } | undefined)?.dir;
          let effectiveCwd: string | undefined;

          if (taskDir) {
            try {
              if (existsSync(taskDir) && statSync(taskDir).isDirectory()) {
                effectiveCwd = taskDir;
              } else {
                console.warn(
                  `[${role}] Task dir "${taskDir}" does not exist or is not a directory, falling back to default cwd`,
                );
              }
            } catch {
              console.warn(
                `[${role}] Failed to check task dir "${taskDir}", falling back to default cwd`,
              );
            }
          }

          if (!effectiveCwd && currentRepoContext?.clonePath) {
            effectiveCwd = currentRepoContext.clonePath;
          }

          // Annotate prompt with working directory context
          if (effectiveCwd && effectiveCwd !== process.cwd()) {
            triggerPrompt += `\n\n---\n**Working Directory**: You are starting in \`${effectiveCwd}\`. `;
            if (taskDir) {
              triggerPrompt += "This was explicitly set on the task.";
            } else if (currentRepoContext?.clonePath) {
              triggerPrompt += "This is the repository clone path for this task's VCS repo.";
            }
            triggerPrompt +=
              " You can still access any path on the filesystem — this is just your starting directory.";
          }

          // Warn in system prompt when task dir was specified but doesn't exist
          let cwdWarning = "";
          if (taskDir && !effectiveCwd) {
            cwdWarning = `\n\nNote: The task requested working directory "${taskDir}" but it does not exist. Falling back to default directory.`;
          }

          // Rebuild system prompt with per-task repo context
          const taskBasePrompt = await buildSystemPrompt();
          const taskSystemPrompt =
            (additionalSystemPrompt
              ? `${taskBasePrompt}\n\n${additionalSystemPrompt}`
              : taskBasePrompt) + cwdWarning;

          iteration++;
          const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
          const taskIdSlice = trigger.taskId?.slice(0, 8) || "notask";
          const logFile = `${logDir}/${timestamp}-${taskIdSlice}.jsonl`;

          console.log(`\n[${role}] === Iteration ${iteration} ===`);
          console.log(`[${role}] Logging to: ${logFile}`);
          console.log(`[${role}] Prompt: ${triggerPrompt.slice(0, 100)}...`);
          if (effectiveCwd) {
            console.log(`[${role}] Working directory: ${effectiveCwd}`);
          }

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

          // Per-task runner session ID so session logs are scoped to this task
          const taskRunnerSessionId = crypto.randomUUID();

          // Spawn without blocking (await to set up session, but process runs async)
          let runningTask: RunningTask;
          try {
            runningTask = await spawnProviderProcess(
              adapter,
              {
                prompt: triggerPrompt,
                logFile,
                systemPrompt: taskSystemPrompt,
                additionalArgs: effectiveAdditionalArgs,
                role,
                apiUrl,
                apiKey,
                agentId,
                runnerSessionId: taskRunnerSessionId,
                iteration,
                taskId: trigger.taskId,
                model: taskModel,
                cwd: effectiveCwd,
              },
              logDir,
              isYolo,
            );
          } catch (spawnErr) {
            const errMsg = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            console.error(
              `[${role}] Failed to spawn process for task ${trigger.taskId?.slice(0, 8) || "unknown"}: ${errMsg}`,
            );
            if (trigger.taskId) {
              await ensureTaskFinished(
                apiConfig,
                role,
                trigger.taskId,
                1,
                `Spawn failed: ${errMsg}`,
              );
            }
            continue;
          }

          ensure({
            id: "worker_process_spawned",
            flow: "task",
            runId: runningTask.taskId,
            depIds: ["worker_received"],
            data: {
              taskId: runningTask.taskId,
              agentId,
              role,
              model: taskModel,
            },
            // biome-ignore lint/correctness/noEmptyPattern: data unused, ctx needed
            filter: ({}, ctx) => ctx.deps.length > 0,
            conditions: [{ timeout_ms: 60_000 }], // 1 min: process startup
          });

          // Attach trigger metadata for logging
          runningTask.triggerType = trigger.type;
          runningTask.workingDir = effectiveCwd;

          // Attach deferred cursor updates for channel_activity triggers
          if (trigger.type === "channel_activity" && trigger.cursorUpdates) {
            runningTask.cursorUpdates = trigger.cursorUpdates as Array<{
              channelId: string;
              ts: string;
            }>;
          }

          state.activeTasks.set(runningTask.taskId, runningTask);

          // Register active session for concurrency awareness
          const taskDesc =
            trigger.task && typeof trigger.task === "object" && "task" in trigger.task
              ? String((trigger.task as { task: string }).task).slice(0, 200)
              : undefined;
          registerActiveSession(apiConfig, {
            taskId: runningTask.taskId,
            triggerType: trigger.type,
            taskDescription: taskDesc,
            runnerSessionId: taskRunnerSessionId,
          });

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

      const iterationResult = await runProviderIteration(adapter, {
        prompt,
        logFile,
        systemPrompt: resolvedSystemPrompt,
        additionalArgs: opts.additionalArgs,
        role,
        apiUrl,
        apiKey,
        agentId,
      });

      if (iterationResult.exitCode !== 0) {
        const failureReason =
          iterationResult.failureReason || `Process exited with code ${iterationResult.exitCode}`;

        const errorLog = {
          timestamp: new Date().toISOString(),
          iteration,
          exitCode: iterationResult.exitCode,
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
          process.exit(iterationResult.exitCode);
        }

        console.warn(`[${role}] ${failureReason}. YOLO mode - continuing...`);
      }

      console.log(`[${role}] Iteration ${iteration} complete. Starting next iteration...`);
    }
  }
}
