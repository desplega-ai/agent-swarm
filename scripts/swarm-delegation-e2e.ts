#!/usr/bin/env bun

import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Subprocess } from "bun";

type AgentRecord = {
  id: string;
  name: string;
  isLead?: boolean;
  status?: string;
};

type TaskRecord = {
  id: string;
  agentId?: string;
  creatorAgentId?: string;
  parentTaskId?: string;
  task: string;
  status: string;
  output?: string;
  createdAt: string;
  lastUpdatedAt: string;
  finishedAt?: string;
};

type ChannelRecord = {
  id: string;
  name: string;
};

type MessageRecord = {
  id: string;
  channelId: string;
  agentId?: string;
  agentName?: string;
  content: string;
  createdAt: string;
};

type EnvMap = Record<string, string>;
type HarnessProvider = "claude" | "pi";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SCRIPT_NAME = "swarm-delegation-e2e";
const GENERAL_CHANNEL_NAME = "general";
const TIMEOUT_MS = 2 * 60 * 1000;
const POLL_INTERVAL_MS = 2_000;
const LOCAL_IMAGE_TAG = "agent-swarm-worker:e2e-local";

const argv = process.argv.slice(2);

function getFlagValue(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  if (index === -1) return undefined;
  return argv[index + 1];
}

function hasFlag(flag: string): boolean {
  return argv.includes(flag);
}

function parseProviderFlag(flag: "--lead-provider" | "--worker-provider"): HarnessProvider | undefined {
  const value = getFlagValue(flag);
  if (value === undefined) return undefined;
  if (value === "claude" || value === "pi") return value;
  throw new Error(`Invalid value for ${flag}: ${value}. Expected "claude" or "pi".`);
}

if (hasFlag("--help") || hasFlag("-h")) {
  console.log(`${SCRIPT_NAME}

Runs a full lead -> worker delegation end-to-end flow against a fresh local API.

Usage:
  bun scripts/swarm-delegation-e2e.ts

Flags:
  --keep-artifacts   Keep temp files and logs on exit
  --skip-build       Do not build the worker image if it is missing
  --lead-provider    Provider for lead: claude | pi
  --worker-provider  Provider for worker: claude | pi
`);
  process.exit(0);
}

const keepArtifacts = hasFlag("--keep-artifacts");
const skipBuild = hasFlag("--skip-build");
const leadProviderOverride = parseProviderFlag("--lead-provider");
const workerProviderOverride = parseProviderFlag("--worker-provider");

let tempRoot = "";
let apiProc: Subprocess | null = null;
const containerNames: string[] = [];
const logFiles: string[] = [];
const seenProgressLines = new Set<string>();
const logFollowers: Subprocess[] = [];

function log(message: string): void {
  console.log(`[${SCRIPT_NAME}] ${message}`);
}

function shortId(value: string | undefined): string {
  return value ? value.slice(0, 8) : "-";
}

function truncateText(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  if (maxLength <= 3) return value.slice(0, maxLength);
  return `${value.slice(0, maxLength - 3)}...`;
}

function providerModel(provider: HarnessProvider): string | undefined {
  if (provider === "pi") {
    return "openrouter/anthropic/claude-sonnet-4.6";
  }
  return undefined;
}

function providerEnv(
  provider: HarnessProvider,
  options: {
    claudeToken: string;
    openRouterKey?: string;
  },
): EnvMap {
  if (provider === "pi") {
    if (!options.openRouterKey) {
      throw new Error("Provider 'pi' requires OPENROUTER_API_KEY in the environment");
    }

    return {
      // Docker entrypoint currently hard-requires this even when runtime provider is pi.
      CLAUDE_CODE_OAUTH_TOKEN: options.claudeToken,
      OPENROUTER_API_KEY: options.openRouterKey,
      HARNESS_PROVIDER: "pi",
      MODEL_OVERRIDE: providerModel("pi")!,
    };
  }

  return {
    CLAUDE_CODE_OAUTH_TOKEN: options.claudeToken,
  };
}

function redactHeaders(headers: HeadersInit | undefined): HeadersInit | undefined {
  if (!headers || Array.isArray(headers)) return headers;
  const normalized = { ...headers } as Record<string, string>;
  if (normalized.Authorization) normalized.Authorization = "Bearer <redacted>";
  return normalized;
}

async function parseDotEnvFile(filePath: string): Promise<EnvMap> {
  const text = await Bun.file(filePath).text();
  const env: EnvMap = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separatorIndex = line.indexOf("=");
    if (separatorIndex === -1) continue;

    const key = line.slice(0, separatorIndex).trim();
    let value = line.slice(separatorIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    env[key] = value;
  }

  return env;
}

function pickRandomPort(): number {
  return 20000 + Math.floor(Math.random() * 20000);
}

async function runCommand(
  cmd: string[],
  options: {
    cwd?: string;
    env?: Record<string, string | undefined>;
    allowFailure?: boolean;
    stdoutFile?: string;
    stderrFile?: string;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const proc = Bun.spawn(cmd, {
    cwd: options.cwd ?? REPO_ROOT,
    env: options.env ? { ...process.env, ...options.env } : process.env,
    stdout: options.stdoutFile ? Bun.file(options.stdoutFile) : "pipe",
    stderr: options.stderrFile ? Bun.file(options.stderrFile) : "pipe",
  });

  const stdout = options.stdoutFile ? "" : await new Response(proc.stdout).text();
  const stderr = options.stderrFile ? "" : await new Response(proc.stderr).text();
  const exitCode = await proc.exited;

  if (exitCode !== 0 && !options.allowFailure) {
    throw new Error(
      `Command failed (${cmd.join(" ")}): ${stderr.trim() || stdout.trim() || `exit ${exitCode}`}`,
    );
  }

  return { stdout, stderr };
}

async function dockerImageExists(tag: string): Promise<boolean> {
  const result = await runCommand(["docker", "image", "inspect", tag], { allowFailure: true });
  return result.stderr.trim() === "";
}

async function buildWorkerImageIfNeeded(): Promise<void> {
  const exists = await dockerImageExists(LOCAL_IMAGE_TAG);
  if (exists) {
    log(`Using existing Docker image ${LOCAL_IMAGE_TAG}`);
    return;
  }

  if (skipBuild) {
    throw new Error(`Docker image ${LOCAL_IMAGE_TAG} not found and --skip-build was provided`);
  }

  log(`Building ${LOCAL_IMAGE_TAG} from local Dockerfile`);
  await runCommand(
    ["docker", "build", "-f", "Dockerfile.worker", "-t", LOCAL_IMAGE_TAG, "."],
    { cwd: REPO_ROOT },
  );
}

async function startApi(env: EnvMap): Promise<void> {
  const stdoutFile = join(tempRoot, "api.stdout.log");
  const stderrFile = join(tempRoot, "api.stderr.log");
  logFiles.push(stdoutFile, stderrFile);

  apiProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: REPO_ROOT,
    env: {
      ...process.env,
      ...env,
    },
    stdout: Bun.file(stdoutFile),
    stderr: Bun.file(stderrFile),
  });
}

async function waitForHealth(baseUrl: string, apiKey: string, timeoutMs = 20_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${baseUrl}/health`, {
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      });
      if (response.ok) return;
    } catch {
      // waiting for startup
    }
    await Bun.sleep(250);
  }
  throw new Error(`API did not become healthy within ${timeoutMs}ms`);
}

async function apiFetch<T>(
  baseUrl: string,
  apiKey: string,
  path: string,
  options: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {},
): Promise<T> {
  const headers: Record<string, string> = {
    ...(options.body !== undefined ? { "Content-Type": "application/json" } : {}),
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    ...(options.headers ?? {}),
  };

  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(
      `API ${options.method ?? "GET"} ${path} failed: ${response.status} ${text} headers=${JSON.stringify(redactHeaders(headers))}`,
    );
  }

  return (await response.json()) as T;
}

async function startContainer(params: {
  name: string;
  image: string;
  env: EnvMap;
  logDir: string;
  sharedDir: string;
  personalDir: string;
}): Promise<void> {
  await mkdir(params.logDir, { recursive: true });
  await mkdir(params.sharedDir, { recursive: true });
  await mkdir(params.personalDir, { recursive: true });

  const cmd = [
    "docker",
    "run",
    "--detach",
    "--rm",
    "--name",
    params.name,
    "-v",
    `${params.logDir}:/logs`,
    "-v",
    `${params.sharedDir}:/workspace/shared`,
    "-v",
    `${params.personalDir}:/workspace/personal`,
  ];

  if (process.platform === "linux") {
    cmd.push("--add-host", "host.docker.internal:host-gateway");
  }

  for (const [key, value] of Object.entries(params.env)) {
    cmd.push("-e", `${key}=${value}`);
  }

  cmd.push(params.image);

  await runCommand(cmd);
  containerNames.push(params.name);
}

function streamLines(
  stream: ReadableStream<Uint8Array> | null | undefined,
  prefix: string,
): void {
  if (!stream) return;

  (async () => {
    const decoder = new TextDecoder();
    let partial = "";
    let lastLine = "";
    let repeatCount = 0;

    const flushRepeatSummary = () => {
      if (repeatCount > 1) {
        log(`${prefix}(previous line repeated ${repeatCount} times)`);
      }
      repeatCount = 0;
    };

    const emitLine = (rawLine: string) => {
      const line = sanitizeStreamLine(rawLine);
      if (!line || shouldDropStreamLine(line)) return;

      if (line === lastLine) {
        repeatCount += 1;
        return;
      }

      flushRepeatSummary();
      lastLine = line;
      repeatCount = 1;
      log(`${prefix}${line}`);
    };

    for await (const chunk of stream) {
      partial += decoder.decode(chunk, { stream: true });
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const line of lines) {
        emitLine(line);
      }
    }

    partial += decoder.decode();
    if (partial) emitLine(partial);
    flushRepeatSummary();
  })().catch((error) => {
    log(`${prefix}log streaming failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function sanitizeStreamLine(value: string): string {
  return value
    .replace(/\r+$/g, "")
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    .trimEnd();
}

function shouldDropStreamLine(value: string): boolean {
  if (!value.trim()) return true;

  if (value.includes("Polling for triggers (0/1 active)...")) return true;
  if (value.includes("At capacity (1/1), waiting for completion...")) return true;

  return (
    value.includes("[message_update]") ||
    value.includes("[message_start]") ||
    value.includes("[message_end]") ||
    value.includes("[turn_start]") ||
    value.includes("[turn_end]") ||
    value.includes("[agent_start]") ||
    value.includes("[tool_execution_update]")
  );
}

function startContainerLogFollower(containerName: string, label: string): void {
  const proc = Bun.spawn(["docker", "logs", "-f", "--tail", "0", containerName], {
    cwd: REPO_ROOT,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });

  logFollowers.push(proc);
  streamLines(proc.stdout, `${label} `);
  streamLines(proc.stderr, `${label} `);
}

async function waitForAgents(baseUrl: string, apiKey: string, expectedAgentIds: string[]): Promise<void> {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const data = await apiFetch<{ agents: AgentRecord[] }>(baseUrl, apiKey, "/api/agents");
    const seen = new Set(data.agents.map((agent) => agent.id));
    for (const agent of data.agents.filter((agent) => expectedAgentIds.includes(agent.id))) {
      const key = `agent:${agent.id}:${agent.status ?? "unknown"}`;
      if (!seenProgressLines.has(key)) {
        seenProgressLines.add(key);
        log(
          `Agent ready: ${agent.name} (${shortId(agent.id)}) lead=${agent.isLead ? "yes" : "no"} status=${agent.status ?? "unknown"}`,
        );
      }
    }
    if (expectedAgentIds.every((id) => seen.has(id))) return;
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for agents to register: ${expectedAgentIds.join(", ")}`);
}

async function getGeneralChannel(baseUrl: string, apiKey: string): Promise<ChannelRecord> {
  const data = await apiFetch<{ channels: ChannelRecord[] }>(baseUrl, apiKey, "/api/channels");
  const general = data.channels.find((channel) => channel.name === GENERAL_CHANNEL_NAME);
  if (!general) throw new Error(`Channel "${GENERAL_CHANNEL_NAME}" not found`);
  return general;
}

async function dumpDiagnostics(baseUrl: string, apiKey: string, generalChannelId?: string): Promise<void> {
  try {
    const [{ agents }, { tasks }] = await Promise.all([
      apiFetch<{ agents: AgentRecord[] }>(baseUrl, apiKey, "/api/agents"),
      apiFetch<{ tasks: TaskRecord[] }>(baseUrl, apiKey, "/api/tasks?limit=200"),
    ]);

    log("Agents snapshot:");
    for (const agent of agents) {
      log(`  - ${agent.name} (${agent.id.slice(0, 8)}) status=${agent.status ?? "unknown"} lead=${agent.isLead ? "yes" : "no"}`);
    }

    log("Tasks snapshot:");
    for (const task of tasks) {
      log(
        `  - ${task.id.slice(0, 8)} status=${task.status} agent=${task.agentId?.slice(0, 8) ?? "-"} creator=${task.creatorAgentId?.slice(0, 8) ?? "-"} parent=${task.parentTaskId?.slice(0, 8) ?? "-"} :: ${truncateText(task.task, 120)}`,
      );
    }

    if (generalChannelId) {
      const { messages } = await apiFetch<{ messages: MessageRecord[] }>(
        baseUrl,
        apiKey,
        `/api/channels/${generalChannelId}/messages?limit=20`,
      );
      log("Recent #general messages:");
      for (const message of messages.slice(-10)) {
        log(
          `  - ${message.createdAt} ${message.agentName ?? "Human"} (${message.agentId?.slice(0, 8) ?? "-"}) :: ${truncateText(message.content, 160)}`,
        );
      }
    }

    for (const containerName of containerNames) {
      const { stdout } = await runCommand(["docker", "logs", "--tail", "120", containerName], {
        allowFailure: true,
      });
      if (stdout.trim()) {
        log(`Docker logs for ${containerName}:`);
        for (const line of stdout.trim().split(/\r?\n/).slice(-40)) {
          log(`  ${line}`);
        }
      }
    }
  } catch (error) {
    log(`Failed to collect diagnostics: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function emitTaskTransitions(tasks: TaskRecord[]): void {
  for (const task of tasks) {
    const progressKey = `task:${task.id}:${task.status}:${task.lastUpdatedAt}`;
    if (seenProgressLines.has(progressKey)) continue;
    seenProgressLines.add(progressKey);
    log(
      `Task update: ${shortId(task.id)} status=${task.status} agent=${shortId(task.agentId)} creator=${shortId(task.creatorAgentId)} parent=${shortId(task.parentTaskId)} :: ${truncateText(task.task, 220)}`,
    );
  }
}

function emitMessageTransitions(messages: MessageRecord[], sinceIso: string): void {
  for (const message of messages) {
    if (message.createdAt < sinceIso) continue;
    const key = `msg:${message.id}`;
    if (seenProgressLines.has(key)) continue;
    seenProgressLines.add(key);
    log(
      `#general message: ${message.createdAt} ${message.agentName ?? "Human"} (${shortId(message.agentId)}) :: ${truncateText(message.content.replace(/\s+/g, " "), 320)}`,
    );
  }
}

async function cleanup(): Promise<void> {
  for (const proc of logFollowers.splice(0).reverse()) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      // ignore
    }
  }

  for (const containerName of [...containerNames].reverse()) {
    await runCommand(["docker", "rm", "-f", containerName], { allowFailure: true });
  }

  if (apiProc) {
    apiProc.kill();
    try {
      await apiProc.exited;
    } catch {
      // ignore
    }
    apiProc = null;
  }

  if (!keepArtifacts && tempRoot) {
    await rm(tempRoot, { recursive: true, force: true });
  } else if (tempRoot) {
    log(`Artifacts kept at ${tempRoot}`);
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(130);
});

process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(143);
});

async function main(): Promise<void> {
  tempRoot = await mkdtemp(join(tmpdir(), "agent-swarm-delegation-e2e-"));

  const dockerEnvPath = resolve(REPO_ROOT, ".env.docker");
  const dockerEnv = await parseDotEnvFile(dockerEnvPath);
  const claudeToken = dockerEnv.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (!claudeToken) {
    throw new Error(`CLAUDE_CODE_OAUTH_TOKEN not found in ${dockerEnvPath}`);
  }

  const openRouterKey = process.env.OPENROUTER_API_KEY?.trim();
  const leadProvider: HarnessProvider =
    leadProviderOverride ?? (openRouterKey ? "claude" : "claude");
  const workerProvider: HarnessProvider =
    workerProviderOverride ?? (openRouterKey ? "pi" : "claude");

  const apiKey = randomBytes(24).toString("hex");
  const port = pickRandomPort();
  const dbPath = join(tempRoot, "agent-swarm-e2e.sqlite");
  const baseUrl = `http://127.0.0.1:${port}`;
  const runId = randomUUID().slice(0, 8);
  const leadId = randomUUID();
  const workerId = randomUUID();
  const leadName = `e2e-lead-${runId}`;
  const workerName = `e2e-worker-${runId}`;

  const taskInstruction = [
    'ping all your workers and report back results in the general chat',
    `Use the exact completion marker "E2E_SUCCESS:${runId}" in the final general chat message.`,
    "Delegate at least one subtask to a worker.",
    "When you finish, summarize which worker responded and whether the delegation succeeded.",
  ].join(" ");

  log(`Temp root: ${tempRoot}`);
  log(`API port: ${port}`);
  log(`Lead provider: ${leadProvider}${leadProvider === "pi" ? ` (${providerModel(leadProvider)})` : ""}`);
  log(`Worker provider: ${workerProvider}${workerProvider === "pi" ? ` (${providerModel(workerProvider)})` : ""}`);

  await buildWorkerImageIfNeeded();

  await startApi({
    PORT: String(port),
    DATABASE_PATH: dbPath,
    API_KEY: apiKey,
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    AGENTMAIL_DISABLE: "true",
    HEARTBEAT_DISABLE: "true",
  });
  await waitForHealth(baseUrl, apiKey);
  log("API is healthy");

  const sharedDir = join(tempRoot, "workspace", "shared");
  await mkdir(sharedDir, { recursive: true });

  await startContainer({
    name: `agent-swarm-e2e-lead-${runId}`,
    image: LOCAL_IMAGE_TAG,
    sharedDir,
    logDir: join(tempRoot, "logs", "lead"),
    personalDir: join(tempRoot, "workspace", "lead"),
    env: {
      ...providerEnv(leadProvider, { claudeToken, openRouterKey }),
      API_KEY: apiKey,
      AGENT_ID: leadId,
      AGENT_NAME: leadName,
      AGENT_ROLE: "lead",
      MCP_BASE_URL: `http://host.docker.internal:${port}`,
      YOLO: "true",
      MAX_CONCURRENT_TASKS: "1",
      SESSION_ID: `lead-${runId}`,
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      AGENTMAIL_DISABLE: "true",
    },
  });
  startContainerLogFollower(`agent-swarm-e2e-lead-${runId}`, "[lead-stream]");

  await startContainer({
    name: `agent-swarm-e2e-worker-${runId}`,
    image: LOCAL_IMAGE_TAG,
    sharedDir,
    logDir: join(tempRoot, "logs", "worker"),
    personalDir: join(tempRoot, "workspace", "worker"),
    env: {
      ...providerEnv(workerProvider, { claudeToken, openRouterKey }),
      API_KEY: apiKey,
      AGENT_ID: workerId,
      AGENT_NAME: workerName,
      AGENT_ROLE: "worker",
      MCP_BASE_URL: `http://host.docker.internal:${port}`,
      YOLO: "true",
      MAX_CONCURRENT_TASKS: "1",
      SESSION_ID: `worker-${runId}`,
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      AGENTMAIL_DISABLE: "true",
    },
  });
  startContainerLogFollower(`agent-swarm-e2e-worker-${runId}`, "[worker-stream]");

  await waitForAgents(baseUrl, apiKey, [leadId, workerId]);
  log("Lead and worker registered");

  const generalChannel = await getGeneralChannel(baseUrl, apiKey);

  const initialTask = await apiFetch<TaskRecord>(baseUrl, apiKey, "/api/tasks", {
    method: "POST",
    body: {
      task: taskInstruction,
      agentId: leadId,
      source: "api",
      taskType: "e2e",
      priority: 100,
    },
  });
  log(`Created initial task ${initialTask.id.slice(0, 8)} for ${leadName}`);
  emitTaskTransitions([initialTask]);

  const startedAt = Date.now();
  let delegationSeen = false;
  let delegatedTaskCompleted = false;
  let finalTaskCompleted = false;
  let finalMessage: MessageRecord | null = null;
  let latestTaskState: TaskRecord | null = null;

  while (Date.now() - startedAt < TIMEOUT_MS) {
    const [{ tasks }, { messages }] = await Promise.all([
      apiFetch<{ tasks: TaskRecord[] }>(baseUrl, apiKey, "/api/tasks?limit=200"),
      apiFetch<{ messages: MessageRecord[] }>(
        baseUrl,
        apiKey,
        `/api/channels/${generalChannel.id}/messages?limit=100`,
      ),
    ]);

    latestTaskState = tasks.find((task) => task.id === initialTask.id) ?? null;
    emitTaskTransitions(tasks);
    emitMessageTransitions(messages, initialTask.createdAt);

    const delegatedTasks = tasks.filter(
      (task) =>
        task.creatorAgentId === leadId &&
        task.id !== initialTask.id &&
        task.agentId === workerId,
    );

    delegationSeen = delegatedTasks.length > 0;
    delegatedTaskCompleted = delegatedTasks.some((task) => task.status === "completed");
    finalTaskCompleted = latestTaskState?.status === "completed";

    finalMessage =
      messages.find(
        (message) =>
          message.createdAt >= initialTask.createdAt &&
          message.content.includes(`E2E_SUCCESS:${runId}`) &&
          Boolean(message.agentId),
      ) ?? null;

    const delegatedTaskIds = delegatedTasks.map((task) => shortId(task.id)).join(", ") || "-";
    const progressKey = [
      latestTaskState?.status ?? "missing",
      delegationSeen ? "1" : "0",
      delegatedTaskCompleted ? "1" : "0",
      finalMessage ? "1" : "0",
      delegatedTaskIds,
    ].join("|");
    const summaryKey = `summary:${progressKey}`;
    if (!seenProgressLines.has(summaryKey)) {
      seenProgressLines.add(summaryKey);
      const progressBits = [
        `lead task=${latestTaskState?.status ?? "missing"}`,
        `delegated=${delegationSeen ? `yes (${delegatedTaskIds})` : "no"}`,
        `worker completed=${delegatedTaskCompleted ? "yes" : "no"}`,
        `general marker=${finalMessage ? "yes" : "no"}`,
      ];
      log(`Progress: ${progressBits.join(", ")}`);
    }

    if (delegationSeen && delegatedTaskCompleted && finalTaskCompleted && finalMessage) {
      break;
    }

    await Bun.sleep(POLL_INTERVAL_MS);
  }

  if (!delegationSeen || !delegatedTaskCompleted || !finalTaskCompleted || !finalMessage) {
    log("E2E verification failed before timeout");
    await dumpDiagnostics(baseUrl, apiKey, generalChannel.id);
    throw new Error(
      [
        !delegationSeen ? "delegation not observed" : null,
        delegationSeen && !delegatedTaskCompleted ? "delegated task never completed" : null,
        !finalTaskCompleted ? `lead task not completed (status=${latestTaskState?.status ?? "missing"})` : null,
        !finalMessage ? "final general chat message not found" : null,
      ]
        .filter(Boolean)
        .join("; "),
    );
  }

  log(`Verified delegation via worker task and final #general post: ${finalMessage.content}`);
  log(`Database path: ${dbPath}`);
}

main()
  .then(async () => {
    await cleanup();
  })
  .catch(async (error) => {
    console.error(`[${SCRIPT_NAME}] Fatal: ${error instanceof Error ? error.message : String(error)}`);
    await cleanup();
    process.exit(1);
  });
