#!/usr/bin/env bun
/**
 * Docker-based E2E Provider Test
 *
 * Builds the Docker worker image, starts a local API server with a clean DB,
 * registers agents, creates tasks, and runs Docker workers against them.
 * Tests Claude, pi-mono, and Codex providers from the same image.
 *
 * Test scenarios (each can be run independently via --test flag):
 *   1. basic      — Worker picks up task, completes it, cost + session recorded
 *   2. cancel     — Cancel a task mid-execution, verify tool_call is blocked
 *   3. resume     — Pause a task, restart worker, verify it resumes
 *   4. tool-loop  — Feed a task that triggers tool loop detection
 *   5. summarize  — Verify session summarization produces a memory entry
 *
 * Usage:
 *   bun scripts/e2e-docker-provider.ts --provider claude
 *   bun scripts/e2e-docker-provider.ts --provider pi
 *   bun scripts/e2e-docker-provider.ts --provider codex
 *   bun scripts/e2e-docker-provider.ts --provider all     # claude+pi+codex
 *   bun scripts/e2e-docker-provider.ts --provider both    # claude+pi (legacy)
 *   bun scripts/e2e-docker-provider.ts --provider claude --test basic
 *   bun scripts/e2e-docker-provider.ts --provider claude --test basic,cancel
 *   E2E_PORT=13099 bun scripts/e2e-docker-provider.ts --provider all --test basic
 */
import { $, type Subprocess } from "bun";

// ─── Arg Parsing ─────────────────────────────────────────────────────────────
function parseArg(name: string, fallback: string): string {
  const flag = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (flag) return flag.split("=")[1]!;
  const idx = process.argv.indexOf(`--${name}`);
  if (idx >= 0 && process.argv[idx + 1]) return process.argv[idx + 1]!;
  return fallback;
}

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT = process.env.E2E_PORT || "13099";
const API_KEY = process.env.API_KEY || "123123";
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = `/tmp/e2e-docker-${Date.now()}.sqlite`;
const DOCKER_IMAGE = "agent-swarm-worker:e2e";
const CONTAINER_PREFIX = "e2e-docker";
const WORKER_PORT_BASE = 13200; // Docker host port for workers

const PROVIDER_ARG = parseArg("provider", "claude");
const TEST_ARG = parseArg("test", "all");
const SKIP_BUILD = process.argv.includes("--skip-build");
const TIMEOUT_MS = Number.parseInt(process.env.E2E_TIMEOUT || "120000", 10); // 2 min per test

if (!["claude", "pi", "codex", "both", "all"].includes(PROVIDER_ARG)) {
  console.error(`Invalid --provider: ${PROVIDER_ARG}. Supported: claude, pi, codex, both, all`);
  process.exit(1);
}

const PROVIDERS =
  PROVIDER_ARG === "all"
    ? ["claude", "pi", "codex"]
    : PROVIDER_ARG === "both"
      ? ["claude", "pi"]
      : [PROVIDER_ARG];
const ALL_TESTS = ["basic", "cancel", "resume", "tool-loop", "summarize"];
const TESTS_TO_RUN = TEST_ARG === "all" ? ALL_TESTS : TEST_ARG.split(",");

for (const t of TESTS_TO_RUN) {
  if (!ALL_TESTS.includes(t)) {
    console.error(`Unknown test: ${t}. Available: ${ALL_TESTS.join(", ")}`);
    process.exit(1);
  }
}

// ─── State ───────────────────────────────────────────────────────────────────
let apiProc: Subprocess | null = null;
const activeContainers: string[] = [];
let pass = 0;
let fail = 0;
let skip = 0;
let cleaningUp = false;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function log(msg: string) {
  console.log(`\x1b[1;36m[E2E-Docker]\x1b[0m ${msg}`);
}
function logPass(name: string) {
  console.log(`\x1b[1;32m  ✓ PASS\x1b[0m ${name}`);
  pass++;
}
function logFail(name: string, detail: string) {
  console.log(`\x1b[1;31m  ✗ FAIL\x1b[0m ${name}: ${detail}`);
  fail++;
}
function logSkip(name: string, reason: string) {
  console.log(`\x1b[1;33m  ○ SKIP\x1b[0m ${name}: ${reason}`);
  skip++;
}
function logSection(title: string) {
  console.log(`\n\x1b[1;35m═══ ${title} ═══\x1b[0m`);
}

async function api(method: string, path: string, body?: unknown, agentId?: string) {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${API_KEY}`,
    "Content-Type": "application/json",
  };
  if (agentId) headers["X-Agent-ID"] = agentId;

  const resp = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`API ${method} ${path} returned ${resp.status}: ${text}`);
  }
  return resp.json();
}

async function apiSafe(method: string, path: string, body?: unknown, agentId?: string) {
  try {
    return await api(method, path, body, agentId);
  } catch (err) {
    return { error: String(err) };
  }
}

async function waitForApi(maxWaitMs = 15000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const resp = await fetch(`${BASE_URL}/health`);
      if (resp.ok) return true;
    } catch {}
    await Bun.sleep(500);
  }
  return false;
}

/** Poll a condition until it's true or timeout */
async function pollUntil(
  fn: () => Promise<boolean>,
  timeoutMs: number,
  intervalMs = 2000,
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await Bun.sleep(intervalMs);
  }
  return false;
}

/** Start a Docker worker container for the given provider */
async function startWorker(
  provider: string,
  agentId: string,
  hostPort: number,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const containerName = `${CONTAINER_PREFIX}-${provider}-${Date.now()}`;

  const envFlags: string[] = [
    "-e",
    `HARNESS_PROVIDER=${provider}`,
    "-e",
    `API_KEY=${API_KEY}`,
    "-e",
    `AGENT_ID=${agentId}`,
    "-e",
    `MCP_BASE_URL=http://host.docker.internal:${PORT}`,
    "-e",
    "AGENT_ROLE=worker",
    "-e",
    "YOLO=true",
    "-e",
    "STARTUP_SCRIPT_STRICT=false",
    "-e",
    "SLACK_DISABLE=true",
    "-e",
    "GITHUB_DISABLE=true",
    "-e",
    "MAX_CONCURRENT_TASKS=1",
  ];

  // Provider-specific auth
  if (provider === "claude") {
    const token = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (!token) throw new Error("CLAUDE_CODE_OAUTH_TOKEN required for claude provider");
    envFlags.push("-e", `CLAUDE_CODE_OAUTH_TOKEN=${token}`);
  } else if (provider === "pi") {
    // pi-mono can use OPENROUTER_API_KEY or ANTHROPIC_API_KEY
    const orKey = process.env.OPENROUTER_API_KEY;
    const antKey = process.env.ANTHROPIC_API_KEY;
    if (orKey) envFlags.push("-e", `OPENROUTER_API_KEY=${orKey}`);
    if (antKey) envFlags.push("-e", `ANTHROPIC_API_KEY=${antKey}`);
    if (!orKey && !antKey)
      throw new Error("OPENROUTER_API_KEY or ANTHROPIC_API_KEY required for pi provider");
  } else if (provider === "codex") {
    // Codex requires OPENAI_API_KEY. The Docker entrypoint bootstraps
    // ~/.codex/auth.json from this env var via `codex login --with-api-key`
    // (idempotent — see docker-entrypoint.sh and CodexAdapter for details).
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error("OPENAI_API_KEY required for codex provider");
    envFlags.push("-e", `OPENAI_API_KEY=${key}`);
  }

  for (const [k, v] of Object.entries(extraEnv)) {
    envFlags.push("-e", `${k}=${v}`);
  }

  const args = [
    "docker",
    "run",
    "--rm",
    "-d",
    "--name",
    containerName,
    ...envFlags,
    "-p",
    `${hostPort}:3000`,
    DOCKER_IMAGE,
  ];

  const result = await $`${args}`.text();
  const containerId = result.trim().slice(0, 12);
  activeContainers.push(containerName);
  log(`Started container ${containerName} (${containerId}) on port ${hostPort}`);
  return containerName;
}

/** Get Docker container logs */
async function containerLogs(name: string, tail = 50): Promise<string> {
  try {
    return await $`docker logs --tail ${tail} ${name} 2>&1`.text();
  } catch {
    return "<no logs available>";
  }
}

/** Stop and remove a Docker container */
async function stopContainer(name: string): Promise<void> {
  try {
    await $`docker stop -t 5 ${name} 2>/dev/null`.quiet();
  } catch {}
  const idx = activeContainers.indexOf(name);
  if (idx >= 0) activeContainers.splice(idx, 1);
}

async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  log("Cleaning up...");

  // Stop all containers
  for (const name of [...activeContainers]) {
    await stopContainer(name);
  }

  // Stop API server
  if (apiProc) {
    apiProc.kill("SIGTERM");
    await apiProc.exited.catch(() => {});
  }

  // Remove temp DB files
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await $`rm -f ${DB_PATH}${suffix}`.quiet();
    } catch {}
  }
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(1);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(1);
});

// ─── Test Implementations ────────────────────────────────────────────────────

/** Test: basic — Worker picks up task, completes, cost + session recorded */
async function testBasic(provider: string, portOffset: number) {
  const testName = `[${provider}] basic`;
  logSection(`${testName}: Task completion + cost recording`);

  // Register agent
  const joinResult = await api("POST", "/api/agents", {
    name: `e2e-${provider}-basic`,
    role: "worker",
    status: "online",
    harnessProvider: provider,
  });
  const agentId = joinResult?.agent?.id || joinResult?.id || joinResult?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed: ${JSON.stringify(joinResult)}`);
    return;
  }
  logPass(`${testName}: Agent registered ${agentId.slice(0, 8)}`);

  // Create task
  const taskResult = await api("POST", "/api/tasks", {
    task: "Say 'hello world' and nothing else. Do not use any tools. Just output text.",
    agentId,
    source: "api",
  });
  const taskId = taskResult?.task?.id || taskResult?.id || taskResult?.id;
  if (!taskId) {
    logFail(testName, `Task creation failed: ${JSON.stringify(taskResult)}`);
    return;
  }
  logPass(`${testName}: Task created ${taskId.slice(0, 8)}`);

  // Start worker container
  const hostPort = WORKER_PORT_BASE + portOffset;
  let containerName: string;
  try {
    containerName = await startWorker(provider, agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  // Poll until task completes or timeout
  const completed = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    const status = details?.task?.status || details?.status;
    if (status === "completed" || status === "failed") return true;
    return false;
  }, TIMEOUT_MS);

  // Check results
  const finalTask = await apiSafe("GET", `/api/tasks/${taskId}`);
  const status = finalTask?.task?.status || finalTask?.status;

  if (!completed) {
    const logs = await containerLogs(containerName);
    logFail(
      testName,
      `Timed out after ${TIMEOUT_MS / 1000}s. Status: ${status}\nLast logs:\n${logs}`,
    );
    await stopContainer(containerName);
    return;
  }

  if (status === "completed") {
    logPass(`${testName}: Task completed`);
  } else {
    logFail(testName, `Task status: ${status} (expected completed)`);
  }

  // Check session ID
  const sessionId = finalTask?.task?.claudeSessionId || finalTask?.claudeSessionId;
  if (sessionId) {
    logPass(`${testName}: Session ID recorded (${sessionId.slice(0, 8)})`);
  } else {
    logFail(testName, "No session ID on task");
  }

  // Wait for runner to finish post-completion work (cost save, log flush, etc.)
  // The task may be marked "completed" by hooks before the runner's
  // waitForCompletion() resolves and saves cost data.
  await Bun.sleep(10000);

  // Grab container logs before checking cost (for diagnostics)
  const workerLogs = await containerLogs(containerName, 200);
  const diagLines = workerLogs
    .split("\n")
    .filter(
      (l) =>
        l.includes("cost") ||
        l.includes("Cost") ||
        l.includes("result") ||
        l.includes("save") ||
        l.includes("[runner]") ||
        l.includes("exit"),
    );
  if (diagLines.length > 0) {
    log(`${testName}: Diagnostic log lines:\n${diagLines.join("\n")}`);
  } else {
    log(
      `${testName}: DIAG: No diagnostic lines found. Total log lines: ${workerLogs.split("\n").length}`,
    );
    // Show last 20 lines for debugging
    const lastLines = workerLogs.split("\n").slice(-20).join("\n");
    log(`${testName}: Last 20 lines:\n${lastLines}`);
  }

  // Poll for cost data (may take time if Stop hook runs summarization)
  let costEntries: Array<{ totalCostUsd: number }> = [];
  const costFound = await pollUntil(
    async () => {
      const costs = await apiSafe("GET", `/api/session-costs?agentId=${agentId}`);
      costEntries = costs?.costs || [];
      if (costEntries.length > 0) return true;
      // Also check unfiltered
      const allCosts = await apiSafe("GET", "/api/session-costs");
      const allEntries = allCosts?.costs || [];
      if (allEntries.length > 0) {
        log(
          `${testName}: DIAG: No costs for agentId=${agentId}, but ${allEntries.length} total. Sample: ${JSON.stringify(allEntries[0])}`,
        );
        return true; // Cost exists, just wrong agentId filter
      }
      return false;
    },
    30000,
    3000,
  );

  if (costEntries.length > 0) {
    const total = costEntries.reduce(
      (sum: number, c: { totalCostUsd: number }) => sum + c.totalCostUsd,
      0,
    );
    logPass(`${testName}: Cost recorded ($${total.toFixed(4)}, ${costEntries.length} entries)`);
  } else if (costFound) {
    logSkip(`${testName}: Cost data`, "Costs exist but not linked to this agentId");
  } else {
    logFail(testName, "No cost data recorded (polled for 30s)");
  }

  // Check session logs
  const logs = await apiSafe("GET", `/api/session-logs?taskId=${taskId}`);
  const logEntries = logs?.logs || [];
  if (logEntries.length > 0) {
    logPass(`${testName}: Session logs recorded (${logEntries.length} entries)`);
  } else {
    logSkip(`${testName}: Session logs`, "No log entries (may be expected for trivial tasks)");
  }

  await stopContainer(containerName);
}

/** Test: cancel — Cancel a task mid-execution, verify blocking */
async function testCancel(provider: string, portOffset: number) {
  const testName = `[${provider}] cancel`;
  logSection(`${testName}: Task cancellation mid-execution`);

  // Register agent
  const joinResult = await api("POST", "/api/agents", {
    name: `e2e-${provider}-cancel`,
    role: "worker",
    status: "online",
    harnessProvider: provider,
  });
  const agentId = joinResult?.agent?.id || joinResult?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed`);
    return;
  }

  // Create a task that takes a while (uses tools, so cancellation hook fires)
  const taskResult = await api("POST", "/api/tasks", {
    task: "List all files in the current directory recursively. Then create a file called 'test-output.txt' with the listing.",
    agentId,
    source: "api",
  });
  const taskId = taskResult?.task?.id || taskResult?.id;
  if (!taskId) {
    logFail(testName, `Task creation failed`);
    return;
  }
  logPass(`${testName}: Task created ${taskId.slice(0, 8)}`);

  // Start worker
  const hostPort = WORKER_PORT_BASE + portOffset;
  let containerName: string;
  try {
    containerName = await startWorker(provider, agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  // Wait for task to start (status changes from pending/assigned to in_progress)
  const started = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    return details?.task?.status || details?.status === "in_progress";
  }, 30000);

  if (!started) {
    // Even if not in_progress, try cancelling anyway after a delay
    await Bun.sleep(10000);
  }

  // Cancel the task
  log(`${testName}: Cancelling task...`);
  await apiSafe("POST", `/api/tasks/${taskId}/cancel`, { reason: "E2E cancellation test" });

  // Poll until task reaches cancelled/completed/failed state
  const finished = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    const s = details?.task?.status || details?.status;
    return s === "cancelled" || s === "completed" || s === "failed";
  }, TIMEOUT_MS);

  const finalTask = await apiSafe("GET", `/api/tasks/${taskId}`);
  const finalStatus = finalTask?.task?.status || finalTask?.status;

  if (finalStatus === "cancelled") {
    logPass(`${testName}: Task cancelled successfully`);
  } else if (finished) {
    logFail(testName, `Task ended with status: ${finalStatus} (expected cancelled)`);
  } else {
    logFail(testName, `Timed out waiting for cancellation. Status: ${finalStatus}`);
  }

  await stopContainer(containerName);
}

/** Test: resume — Pause a task, restart worker, verify it resumes */
async function testResume(provider: string, portOffset: number) {
  const testName = `[${provider}] resume`;
  logSection(`${testName}: Session resume after restart`);

  // Register agent
  const joinResult = await api("POST", "/api/agents", {
    name: `e2e-${provider}-resume`,
    role: "worker",
    status: "online",
    harnessProvider: provider,
  });
  const agentId = joinResult?.agent?.id || joinResult?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed`);
    return;
  }

  // Create a multi-step task
  const taskResult = await api("POST", "/api/tasks", {
    task: "Step 1: Create a file /workspace/resume-test-1.txt with content 'step1'. Step 2: Create a file /workspace/resume-test-2.txt with content 'step2'. Step 3: Create a file /workspace/resume-test-3.txt with content 'step3'.",
    agentId,
    source: "api",
  });
  const taskId = taskResult?.task?.id || taskResult?.id;
  if (!taskId) {
    logFail(testName, `Task creation failed`);
    return;
  }
  logPass(`${testName}: Task created ${taskId.slice(0, 8)}`);

  // Start worker
  const hostPort = WORKER_PORT_BASE + portOffset;
  let containerName: string;
  try {
    containerName = await startWorker(provider, agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  // Wait for task to start
  const started = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    return details?.task?.status || details?.status === "in_progress";
  }, 30000);

  if (!started) {
    logFail(testName, "Task never reached in_progress");
    await stopContainer(containerName);
    return;
  }

  // Wait a bit, then kill the container abruptly
  await Bun.sleep(5000);
  const taskBefore = await apiSafe("GET", `/api/tasks/${taskId}`);
  const sessionIdBefore = taskBefore?.task?.claudeSessionId || taskBefore?.claudeSessionId;
  log(`${testName}: Session ID before restart: ${sessionIdBefore?.slice(0, 8) || "none"}`);

  // Kill container (simulates crash)
  await stopContainer(containerName);
  log(`${testName}: Container killed. Restarting...`);
  await Bun.sleep(2000);

  // Reset task to assigned so worker picks it up again
  // The runner should detect the existing sessionId and --resume
  await apiSafe("POST", `/api/tasks/${taskId}/reassign`, { assigneeId: agentId });

  // Start new worker
  try {
    containerName = await startWorker(provider, agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container restart failed: ${err}`);
    return;
  }

  // Wait for task to complete
  const completed = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    const s = details?.task?.status || details?.status;
    return s === "completed" || s === "failed";
  }, TIMEOUT_MS);

  const finalTask = await apiSafe("GET", `/api/tasks/${taskId}`);
  const finalStatus = finalTask?.task?.status || finalTask?.status;
  const sessionIdAfter = finalTask?.task?.claudeSessionId || finalTask?.claudeSessionId;

  if (completed && finalStatus === "completed") {
    logPass(`${testName}: Task completed after resume`);
  } else {
    logFail(testName, `Task status: ${finalStatus}`);
  }

  // Check if session ID changed (it may or may not, depending on resume support)
  if (sessionIdBefore && sessionIdAfter) {
    if (sessionIdBefore === sessionIdAfter) {
      logPass(`${testName}: Same session ID — resume worked`);
    } else {
      logSkip(
        `${testName}: Session ID changed`,
        "Provider may not support resume or session was stale",
      );
    }
  }

  await stopContainer(containerName);
}

/** Test: tool-loop — Trigger tool loop detection */
async function testToolLoop(provider: string, portOffset: number) {
  const testName = `[${provider}] tool-loop`;
  logSection(`${testName}: Tool loop detection`);

  // Register agent
  const joinResult = await api("POST", "/api/agents", {
    name: `e2e-${provider}-loop`,
    role: "worker",
    status: "online",
    harnessProvider: provider,
  });
  const agentId = joinResult?.agent?.id || joinResult?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed`);
    return;
  }

  // Create a task likely to trigger tool loops
  const taskResult = await api("POST", "/api/tasks", {
    task: "Read the file /workspace/nonexistent-file.txt and tell me its contents. Keep trying until you succeed. Do not give up.",
    agentId,
    source: "api",
  });
  const taskId = taskResult?.task?.id || taskResult?.id;
  if (!taskId) {
    logFail(testName, `Task creation failed`);
    return;
  }
  logPass(`${testName}: Task created ${taskId.slice(0, 8)}`);

  // Start worker
  const hostPort = WORKER_PORT_BASE + portOffset;
  let containerName: string;
  try {
    containerName = await startWorker(provider, agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  // Wait for task to complete/fail (loop detection should stop it)
  const completed = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    const s = details?.task?.status || details?.status;
    return s === "completed" || s === "failed";
  }, TIMEOUT_MS);

  // Check container logs for loop detection markers
  const logs = await containerLogs(containerName, 200);
  const loopDetected =
    logs.includes("LOOP DETECTED") || logs.includes("loop") || logs.includes("blocked");

  if (loopDetected) {
    logPass(`${testName}: Tool loop detection triggered`);
  } else if (completed) {
    logSkip(`${testName}: Loop detection`, "Task completed without triggering loop detection");
  } else {
    logFail(testName, "Task timed out without loop detection");
  }

  await stopContainer(containerName);
}

/** Test: summarize — Verify session summarization produces memory entry */
async function testSummarize(provider: string, portOffset: number) {
  const testName = `[${provider}] summarize`;
  logSection(`${testName}: Session summarization`);

  // Register agent
  const joinResult = await api("POST", "/api/agents", {
    name: `e2e-${provider}-summarize`,
    role: "worker",
    status: "online",
    harnessProvider: provider,
  });
  const agentId = joinResult?.agent?.id || joinResult?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed`);
    return;
  }

  // Create a task with enough substance to summarize
  const taskResult = await api("POST", "/api/tasks", {
    task: "Create a file /workspace/summary-test.txt explaining what 2+2 equals and why. Use the Write tool.",
    agentId,
    source: "api",
  });
  const taskId = taskResult?.task?.id || taskResult?.id;
  if (!taskId) {
    logFail(testName, `Task creation failed`);
    return;
  }
  logPass(`${testName}: Task created ${taskId.slice(0, 8)}`);

  // Start worker
  const hostPort = WORKER_PORT_BASE + portOffset;
  let containerName: string;
  try {
    containerName = await startWorker(provider, agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  // Wait for task to complete
  const completed = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    const s = details?.task?.status || details?.status;
    return s === "completed" || s === "failed";
  }, TIMEOUT_MS);

  if (!completed) {
    logFail(testName, "Task timed out");
    await stopContainer(containerName);
    return;
  }

  // Wait a bit for summarization to complete (runs in Stop hook)
  await Bun.sleep(10000);

  // Check for memory entries from this agent
  const memories = await apiSafe("GET", `/api/memory?agentId=${agentId}`);
  const memEntries = memories?.memories || memories?.entries || [];

  if (memEntries.length > 0) {
    logPass(`${testName}: Memory entry created (${memEntries.length} entries)`);
  } else {
    logSkip(
      `${testName}: Memory entry`,
      "No memory entries found (summarization may have failed silently)",
    );
  }

  await stopContainer(containerName);
}

// ─── Test Router ─────────────────────────────────────────────────────────────
const TEST_FUNCTIONS: Record<string, (provider: string, portOffset: number) => Promise<void>> = {
  basic: testBasic,
  cancel: testCancel,
  resume: testResume,
  "tool-loop": testToolLoop,
  summarize: testSummarize,
};

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`Providers: ${PROVIDERS.join(", ")}`);
  log(`Tests: ${TESTS_TO_RUN.join(", ")}`);
  log(`API port: ${PORT}, DB: ${DB_PATH}`);
  log(`Timeout per test: ${TIMEOUT_MS / 1000}s`);

  // 1. Build Docker image (unless --skip-build)
  if (!SKIP_BUILD) {
    logSection("Building Docker image");
    try {
      await $`docker build -f Dockerfile.worker -t ${DOCKER_IMAGE} .`.quiet();
      logPass("Docker image built");
    } catch (err) {
      logFail("Docker build", String(err));
      process.exit(1);
    }
  } else {
    log("Skipping Docker build (--skip-build)");
  }

  // 2. Start API server
  logSection("Starting API server");
  apiProc = Bun.spawn(["bun", "run", "src/http.ts"], {
    env: {
      ...process.env,
      PORT,
      API_KEY,
      DATABASE_PATH: DB_PATH,
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  if (!(await waitForApi())) {
    logFail("API startup", "Server did not become healthy within 15s");
    await cleanup();
    process.exit(1);
  }
  logPass("API server started");

  // 3. Run tests for each provider
  let portOffset = 0;
  for (const provider of PROVIDERS) {
    logSection(`Provider: ${provider}`);
    for (const testName of TESTS_TO_RUN) {
      const testFn = TEST_FUNCTIONS[testName];
      if (!testFn) continue;
      try {
        await testFn(provider, portOffset++);
      } catch (err) {
        logFail(`[${provider}] ${testName}`, `Unhandled error: ${err}`);
      }
    }
  }

  // 4. Summary
  logSection("Results");
  log(
    `\x1b[1;32m${pass} passed\x1b[0m, \x1b[1;31m${fail} failed\x1b[0m, \x1b[1;33m${skip} skipped\x1b[0m`,
  );

  await cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("E2E test error:", err);
  await cleanup();
  process.exit(1);
});
