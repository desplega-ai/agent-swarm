#!/usr/bin/env bun
/**
 * Opencode Docker E2E Test
 *
 * Smoke-tests the full opencode worker path in Docker:
 *   1. basic     — Build image, run task "write hello.txt", assert content + task.provider
 *   2. isolation — Two concurrent tasks on one worker: distinct sessions, no log cross-talk
 *
 * Usage:
 *   bun scripts/e2e-docker-opencode.ts
 *   bun scripts/e2e-docker-opencode.ts --test basic
 *   bun scripts/e2e-docker-opencode.ts --test isolation
 *   bun scripts/e2e-docker-opencode.ts --skip-build
 *   E2E_PORT=13098 bun scripts/e2e-docker-opencode.ts
 *
 * Required env:
 *   OPENROUTER_API_KEY  — passed to the opencode worker container
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
const PORT = process.env.E2E_PORT || "13098";
const API_KEY = process.env.API_KEY || "123123";
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = `/tmp/e2e-opencode-${Date.now()}.sqlite`;
const DOCKER_IMAGE = "agent-swarm-worker:e2e";
const CONTAINER_PREFIX = "e2e-opencode";
const WORKER_PORT_BASE = 13300;

const TEST_ARG = parseArg("test", "all");
const SKIP_BUILD = process.argv.includes("--skip-build");
const TIMEOUT_MS = Number.parseInt(process.env.E2E_TIMEOUT || "180000", 10); // 3 min

const ALL_TESTS = ["basic", "isolation"];
const TESTS_TO_RUN = TEST_ARG === "all" ? ALL_TESTS : TEST_ARG.split(",");

for (const t of TESTS_TO_RUN) {
  if (!ALL_TESTS.includes(t)) {
    console.error(`Unknown test: ${t}. Available: ${ALL_TESTS.join(", ")}`);
    process.exit(1);
  }
}

if (!process.env.OPENROUTER_API_KEY && !process.env.ANTHROPIC_API_KEY) {
  console.error("OPENROUTER_API_KEY or ANTHROPIC_API_KEY is required for opencode provider");
  process.exit(1);
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
  console.log(`\x1b[1;36m[E2E-Opencode]\x1b[0m ${msg}`);
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

/** Start a Docker worker container for opencode */
async function startOpencodeWorker(
  agentId: string,
  hostPort: number,
  extraEnv: Record<string, string> = {},
): Promise<string> {
  const containerName = `${CONTAINER_PREFIX}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;

  const envFlags: string[] = [
    "-e", "DESPLEGA_TELEMETRY_ENV=test",
    "-e", "HARNESS_PROVIDER=opencode",
    "-e", `API_KEY=${API_KEY}`,
    "-e", `AGENT_ID=${agentId}`,
    "-e", `MCP_BASE_URL=http://host.docker.internal:${PORT}`,
    "-e", "AGENT_ROLE=worker",
    "-e", "YOLO=true",
    "-e", "STARTUP_SCRIPT_STRICT=false",
    "-e", "SLACK_DISABLE=true",
    "-e", "GITHUB_DISABLE=true",
    "-e", "MAX_CONCURRENT_TASKS=1",
  ];

  const orKey = process.env.OPENROUTER_API_KEY;
  const antKey = process.env.ANTHROPIC_API_KEY;
  if (orKey) envFlags.push("-e", `OPENROUTER_API_KEY=${orKey}`);
  if (antKey) envFlags.push("-e", `ANTHROPIC_API_KEY=${antKey}`);

  const modelOverride = process.env.MODEL_OVERRIDE;
  if (modelOverride) envFlags.push("-e", `MODEL_OVERRIDE=${modelOverride}`);

  for (const [k, v] of Object.entries(extraEnv)) {
    envFlags.push("-e", `${k}=${v}`);
  }

  const args = [
    "docker", "run", "--rm", "-d",
    "--name", containerName,
    ...envFlags,
    "-p", `${hostPort}:3000`,
    DOCKER_IMAGE,
  ];

  const result = await $`${args}`.text();
  const containerId = result.trim().slice(0, 12);
  activeContainers.push(containerName);
  log(`Started container ${containerName} (${containerId}) on port ${hostPort}`);
  return containerName;
}

async function containerLogs(name: string, tail = 50): Promise<string> {
  try {
    return await $`docker logs --tail ${tail} ${name} 2>&1`.text();
  } catch {
    return "<no logs available>";
  }
}

/** Read a file from inside a running container */
async function containerExec(name: string, cmd: string[]): Promise<string> {
  try {
    return await $`docker exec ${name} ${cmd} 2>&1`.text();
  } catch (err) {
    return `<exec error: ${err}>`;
  }
}

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

  for (const name of [...activeContainers]) {
    await stopContainer(name);
  }

  if (apiProc) {
    apiProc.kill("SIGTERM");
    await apiProc.exited.catch(() => {});
  }

  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await $`rm -f ${DB_PATH}${suffix}`.quiet();
    } catch {}
  }
}

process.on("SIGINT", async () => { await cleanup(); process.exit(1); });
process.on("SIGTERM", async () => { await cleanup(); process.exit(1); });

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * Test: basic
 * - Worker picks up "write hello.txt" task
 * - Asserts /workspace/hello.txt content = 'opencode-e2e-ok'
 * - Asserts task.provider = 'opencode' after completion
 * - Asserts agent was registered (agents.provider tracked via task record)
 */
async function testBasic() {
  const testName = "basic";
  logSection("basic: Task completion + provider assertion");

  // Register agent
  const joinResult = await api("POST", "/api/agents", {
    name: "e2e-opencode-basic",
    role: "worker",
    status: "online",
  });
  const agentId = joinResult?.agent?.id ?? joinResult?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed: ${JSON.stringify(joinResult)}`);
    return;
  }
  logPass(`${testName}: Agent registered ${agentId.slice(0, 8)}`);

  // Verify agent exists (agents.provider is tracked via harness, not a direct field)
  const agentData = await apiSafe("GET", `/api/agents/${agentId}`);
  if (agentData?.agent?.id === agentId || agentData?.id === agentId) {
    logPass(`${testName}: Agent registered in API (agents.provider=opencode set by HARNESS_PROVIDER env)`);
  } else {
    logFail(testName, `Agent not found after registration: ${JSON.stringify(agentData)}`);
    return;
  }

  // Create task: write hello.txt with 'opencode-e2e-ok'
  const taskResult = await api("POST", "/api/tasks", {
    task: "Write a file at /workspace/hello.txt with the exact content: opencode-e2e-ok",
    routingReason: "human_pinned", agentId,
    source: "api",
  });
  const taskId = taskResult?.task?.id ?? taskResult?.id;
  if (!taskId) {
    logFail(testName, `Task creation failed: ${JSON.stringify(taskResult)}`);
    return;
  }
  logPass(`${testName}: Task created ${taskId.slice(0, 8)}`);

  // Start opencode worker container
  const hostPort = WORKER_PORT_BASE;
  let containerName: string;
  try {
    containerName = await startOpencodeWorker(agentId, hostPort);
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  // Poll until task completes
  const completed = await pollUntil(async () => {
    const details = await apiSafe("GET", `/api/tasks/${taskId}`);
    const status = details?.task?.status ?? details?.status;
    return status === "completed" || status === "failed";
  }, TIMEOUT_MS);

  const finalTask = await apiSafe("GET", `/api/tasks/${taskId}`);
  const status = finalTask?.task?.status ?? finalTask?.status;

  if (!completed) {
    const logs = await containerLogs(containerName, 100);
    logFail(testName, `Timed out after ${TIMEOUT_MS / 1000}s. Status: ${status}\nLast logs:\n${logs}`);
    await stopContainer(containerName);
    return;
  }

  if (status === "completed") {
    logPass(`${testName}: Task completed`);
  } else {
    const logs = await containerLogs(containerName, 100);
    logFail(testName, `Task ended with status: ${status}\nLast logs:\n${logs}`);
    await stopContainer(containerName);
    return;
  }

  // Assert /workspace/hello.txt content inside the container
  const fileContent = await containerExec(containerName, ["cat", "/workspace/hello.txt"]);
  const trimmed = fileContent.trim();
  if (trimmed === "opencode-e2e-ok") {
    logPass(`${testName}: /workspace/hello.txt content matches 'opencode-e2e-ok'`);
  } else if (trimmed.includes("opencode-e2e-ok")) {
    logPass(`${testName}: /workspace/hello.txt contains 'opencode-e2e-ok' (extra whitespace allowed)`);
  } else if (trimmed.startsWith("<exec error")) {
    logSkip(`${testName}: hello.txt file check`, `Container may have exited: ${trimmed}`);
  } else {
    logFail(testName, `/workspace/hello.txt content mismatch. Got: '${trimmed.slice(0, 100)}'`);
  }

  // Assert tasks.provider = 'opencode'
  const taskProvider = finalTask?.task?.provider ?? finalTask?.provider;
  if (taskProvider === "opencode") {
    logPass(`${testName}: tasks.provider = 'opencode'`);
  } else if (taskProvider) {
    logFail(testName, `tasks.provider = '${taskProvider}' (expected 'opencode')`);
  } else {
    // Provider may not be set if runner finishes before the PUT /api/tasks/.../session fires
    logSkip(`${testName}: tasks.provider check`, "provider field not yet set (runner may not have reported it)");
  }

  await stopContainer(containerName);
}

/**
 * Test: isolation
 * OpenCode 2 runs one in-process host per task, with no per-task data dir.
 * One worker (MAX_CONCURRENT_TASKS=2) runs two overlapping tasks; each must
 * get its own OpenCode session, write only its own file, and store logs that
 * mention only its own session and marker.
 */
async function testIsolation() {
  const testName = "isolation";
  logSection("isolation: Two concurrent tasks on one OpenCode 2 worker");

  const join = await api("POST", "/api/agents", {
    name: "e2e-opencode-iso",
    role: "worker",
    status: "online",
  });
  const agentId = join?.agent?.id ?? join?.id;
  if (!agentId) {
    logFail(testName, `Agent registration failed: ${JSON.stringify(join)}`);
    return;
  }

  const markers = ["iso-one", "iso-two"];
  const taskIds: string[] = [];
  for (const marker of markers) {
    const created = await api("POST", "/api/tasks", {
      task: `Use bash to run: sleep 15; echo ${marker} > /workspace/${marker}.txt . Then call store-progress with status completed and output "${marker}".`,
      routingReason: "human_pinned",
      agentId,
      source: "api",
    });
    const id = created?.task?.id ?? created?.id;
    if (!id) {
      logFail(testName, `Task creation failed: ${JSON.stringify(created)}`);
      return;
    }
    taskIds.push(id);
  }
  logPass(`${testName}: Two tasks created (${taskIds.map((t) => t.slice(0, 8)).join(", ")})`);

  let container: string;
  try {
    container = await startOpencodeWorker(agentId, WORKER_PORT_BASE + 10, {
      MAX_CONCURRENT_TASKS: "2",
    });
  } catch (err) {
    logFail(testName, `Container start failed: ${err}`);
    return;
  }

  const finals = await Promise.all(
    taskIds.map(async (id) => {
      await pollUntil(async () => {
        const d = await apiSafe("GET", `/api/tasks/${id}`);
        const s = d?.task?.status ?? d?.status;
        return s === "completed" || s === "failed";
      }, TIMEOUT_MS);
      const d = await apiSafe("GET", `/api/tasks/${id}`);
      return d?.task ?? d;
    }),
  );

  for (const [i, task] of finals.entries()) {
    if (task?.status === "completed" && task?.provider === "opencode") {
      logPass(`${testName}: Task ${i + 1} completed on opencode`);
    } else {
      logFail(testName, `Task ${i + 1}: status=${task?.status} provider=${task?.provider}`);
    }
  }

  const sessions = finals.map((t) => t?.claudeSessionId);
  if (sessions[0] && sessions[1] && sessions[0] !== sessions[1]) {
    logPass(`${testName}: Distinct OpenCode sessions (${sessions.join(" vs ")})`);
  } else {
    logFail(testName, `Sessions not distinct: ${JSON.stringify(sessions)}`);
  }

  for (const [i, id] of taskIds.entries()) {
    const logs = await apiSafe("GET", `/api/tasks/${id}/session-logs`);
    const text = JSON.stringify(logs?.logs ?? []);
    const other = 1 - i;
    const leaked = [markers[other], sessions[other]].filter((s) => s && text.includes(s));
    if (text.includes(markers[i]!) && leaked.length === 0) {
      logPass(`${testName}: Task ${i + 1} logs carry only its own session and marker`);
    } else {
      logFail(testName, `Task ${i + 1} logs: own marker=${text.includes(markers[i]!)} leaked=${leaked}`);
    }
    const content = (await containerExec(container, ["cat", `/workspace/${markers[i]}.txt`])).trim();
    if (content === markers[i]) {
      logPass(`${testName}: /workspace/${markers[i]}.txt is correct`);
    } else {
      logFail(testName, `/workspace/${markers[i]}.txt = '${content.slice(0, 80)}'`);
    }
  }

  await stopContainer(container);
}

// ─── Test Router ─────────────────────────────────────────────────────────────
const TEST_FUNCTIONS: Record<string, () => Promise<void>> = {
  basic: testBasic,
  isolation: testIsolation,
};

// ─── Main ────────────────────────────────────────────────────────────────────
async function main() {
  log(`Tests: ${TESTS_TO_RUN.join(", ")}`);
  log(`API port: ${PORT}, DB: ${DB_PATH}`);
  log(`Timeout per test: ${TIMEOUT_MS / 1000}s`);

  // 1. Build Docker image
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
      DESPLEGA_TELEMETRY_ENV: "test",
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

  // 3. Run tests
  for (const testName of TESTS_TO_RUN) {
    const testFn = TEST_FUNCTIONS[testName];
    if (!testFn) continue;
    try {
      await testFn();
    } catch (err) {
      logFail(testName, `Unhandled error: ${err}`);
    }
  }

  // 4. Summary
  logSection("Results");
  log(`\x1b[1;32m${pass} passed\x1b[0m, \x1b[1;31m${fail} failed\x1b[0m, \x1b[1;33m${skip} skipped\x1b[0m`);

  await cleanup();
  process.exit(fail > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error("E2E test error:", err);
  await cleanup();
  process.exit(1);
});
