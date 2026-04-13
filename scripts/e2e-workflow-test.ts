#!/usr/bin/env bun
/**
 * E2E Workflow Engine Test
 *
 * Spins up the full API server with a clean DB, optionally builds & runs
 * Docker lead+worker containers, then exercises the workflow REST API:
 *   - CRUD lifecycle
 *   - Trigger with property-match routing (pass + reject)
 *   - Code-match node execution
 *   - Disabled workflow rejection
 *   - Webhook secret auth
 *   - Failed-run retry
 *   - Delete
 *
 * Usage:
 *   bun scripts/e2e-workflow-test.ts                  # API-only (no docker)
 *   bun scripts/e2e-workflow-test.ts --with-docker    # Also build+spawn docker lead/worker
 *   E2E_PORT=13099 bun scripts/e2e-workflow-test.ts   # Custom port
 */
import { type Subprocess, $ } from "bun";

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.E2E_PORT || "13099";
const API_KEY = process.env.API_KEY || "123123";
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = `/tmp/e2e-workflow-${Date.now()}.sqlite`;
const AGENT_ID = crypto.randomUUID();
const WITH_DOCKER = process.argv.includes("--with-docker");
const DOCKER_IMAGE = "agent-swarm-worker:e2e";
const LEAD_CONTAINER = `e2e-lead-${Date.now()}`;
const WORKER_CONTAINER = `e2e-worker-${Date.now()}`;
const LEAD_PORT = Number(PORT) + 101; // e.g. 13200
const WORKER_PORT = Number(PORT) + 102; // e.g. 13201

// ─── State ──────────────────────────────────────────────────────────────────
let apiProc: Subprocess | null = null;
const dockerContainers: string[] = [];
let pass = 0;
let fail = 0;
let cleaningUp = false;

// ─── Helpers ────────────────────────────────────────────────────────────────
function log(msg: string) {
  console.log(`\x1b[1;34m[E2E]\x1b[0m ${msg}`);
}
function logPass(name: string) {
  console.log(`\x1b[1;32m  PASS\x1b[0m ${name}`);
  pass++;
}
function logFail(name: string, detail: string) {
  console.log(`\x1b[1;31m  FAIL\x1b[0m ${name}: ${detail}`);
  fail++;
}

function assert(condition: boolean, name: string, detail = "") {
  if (condition) logPass(name);
  else logFail(name, detail || "assertion failed");
}

function assertEq(actual: unknown, expected: unknown, name: string) {
  if (actual === expected) logPass(name);
  else logFail(name, `expected '${expected}', got '${actual}'`);
}

async function api<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; data: T }> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
      "X-Agent-ID": AGENT_ID,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  let data: T;
  try {
    data = (await res.json()) as T;
  } catch {
    data = null as T;
  }
  return { status: res.status, data };
}

/** fetch without X-Agent-ID header (for auth tests) */
async function fetchNoAgent(
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number }> {
  const opts: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${API_KEY}`,
    },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE_URL}${path}`, opts);
  try {
    await res.text();
  } catch {
    /* drain */
  }
  return { status: res.status };
}

async function waitForServer(url: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`${url}/api/agents`, {
        headers: { Authorization: `Bearer ${API_KEY}` },
      });
      if (res.ok) return;
    } catch {
      // not ready yet
    }
    await Bun.sleep(500);
  }
  throw new Error(`Server at ${url} did not start within ${timeoutMs}ms`);
}

// ─── Cleanup ────────────────────────────────────────────────────────────────
async function cleanup() {
  if (cleaningUp) return;
  cleaningUp = true;
  log("Cleaning up...");

  // Stop docker containers
  for (const name of dockerContainers) {
    try {
      await $`docker stop ${name}`.quiet();
      log(`Stopped container ${name}`);
    } catch {
      // already stopped
    }
    try {
      await $`docker rm -f ${name}`.quiet();
    } catch {
      // already removed
    }
  }

  // Kill API process
  if (apiProc) {
    try {
      apiProc.kill("SIGTERM");
      // Give it a moment to shut down gracefully
      await Bun.sleep(1000);
      if (apiProc.exitCode === null) apiProc.kill("SIGKILL");
    } catch {
      // already dead
    }
    apiProc = null;
  }

  // Remove temp DB files
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await $`rm -f ${DB_PATH}${suffix}`.quiet();
    } catch {
      // fine
    }
  }

  log("Cleanup complete.");
}

process.on("SIGINT", async () => {
  await cleanup();
  process.exit(fail > 0 ? 1 : 0);
});
process.on("SIGTERM", async () => {
  await cleanup();
  process.exit(fail > 0 ? 1 : 0);
});

// ─── Step 0: Start API server ───────────────────────────────────────────────
async function startApi() {
  log(`Starting API server on port ${PORT} with DB at ${DB_PATH}...`);
  apiProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: import.meta.dir + "/..",
    env: {
      ...process.env,
      PORT,
      API_KEY,
      DATABASE_PATH: DB_PATH,
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      HEARTBEAT_DISABLE: "true",
      // Prevent agentmail init from failing
      AGENTMAIL_DISABLE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

  // Stream API logs in background (prefix with [API])
  const decoder = new TextDecoder();
  const pipeOutput = async (stream: ReadableStream<Uint8Array>, prefix: string) => {
    const reader = stream.getReader();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (line.trim()) console.log(`  \x1b[90m${prefix}\x1b[0m ${line}`);
        }
      }
    } catch {
      // stream closed
    }
  };
  pipeOutput(apiProc.stdout, "[API]");
  pipeOutput(apiProc.stderr, "[API]");

  await waitForServer(BASE_URL);
  log("API server is up.");
}

// ─── Step 1: Build Docker ───────────────────────────────────────────────────
async function buildDocker() {
  log("Building Docker worker image...");
  const projectRoot = import.meta.dir + "/..";
  await $`docker build -f Dockerfile.worker -t ${DOCKER_IMAGE} ${projectRoot}`;
  log("Docker image built.");
}

// ─── Step 2: Spawn lead + worker containers ─────────────────────────────────
async function spawnContainers() {
  const projectRoot = import.meta.dir + "/..";
  const envDockerPath = `${projectRoot}/.env.docker`;

  // Lead
  log(`Spawning lead container (${LEAD_CONTAINER}) on port ${LEAD_PORT}...`);
  await $`docker run --rm -d \
    --name ${LEAD_CONTAINER} \
    --env-file ${envDockerPath} \
    -e MCP_BASE_URL=http://host.docker.internal:${PORT} \
    -e AGENT_ROLE=lead \
    -e MAX_CONCURRENT_TASKS=1 \
    -p ${String(LEAD_PORT)}:3000 \
    ${DOCKER_IMAGE}`.quiet();
  dockerContainers.push(LEAD_CONTAINER);
  log("Lead container started.");

  // Worker
  log(`Spawning worker container (${WORKER_CONTAINER}) on port ${WORKER_PORT}...`);
  await $`docker run --rm -d \
    --name ${WORKER_CONTAINER} \
    --env-file ${envDockerPath} \
    -e MCP_BASE_URL=http://host.docker.internal:${PORT} \
    -e AGENT_ROLE=worker \
    -e MAX_CONCURRENT_TASKS=1 \
    -p ${String(WORKER_PORT)}:3000 \
    ${DOCKER_IMAGE}`.quiet();
  dockerContainers.push(WORKER_CONTAINER);
  log("Worker container started.");

  // Wait a few seconds for containers to register with the API
  log("Waiting for containers to register...");
  await Bun.sleep(5000);

  // Verify containers are running
  const leadRunning =
    (await $`docker inspect -f '{{.State.Running}}' ${LEAD_CONTAINER}`.quiet().text()).trim() ===
    "true";
  const workerRunning =
    (await $`docker inspect -f '{{.State.Running}}' ${WORKER_CONTAINER}`.quiet().text()).trim() ===
    "true";
  assert(leadRunning, "Lead container is running");
  assert(workerRunning, "Worker container is running");
}

// ─── Workflow Definitions (configurable) ────────────────────────────────────
interface WorkflowScenario {
  name: string;
  definition: {
    nodes: Array<{ id: string; type: string; config: Record<string, unknown> }>;
    edges: Array<{ id: string; source: string; sourcePort: string; target: string }>;
  };
}

const SCENARIOS: Record<string, WorkflowScenario> = {
  /** trigger-webhook → property-match (priority > 5) → create-task */
  triagePriority: {
    name: "e2e-triage-priority",
    definition: {
      nodes: [
        { id: "t1", type: "trigger-webhook", config: {} },
        {
          id: "pm1",
          type: "property-match",
          config: {
            conditions: [{ field: "trigger.priority", op: "gt", value: 5 }],
          },
        },
        {
          id: "ct1",
          type: "create-task",
          config: { template: "High priority: {{trigger.title}}" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", sourcePort: "default", target: "pm1" },
        { id: "e2", source: "pm1", sourcePort: "true", target: "ct1" },
      ],
    },
  },

  /** trigger-webhook → code-match (checks tags) → create-task */
  codeMatchTags: {
    name: "e2e-code-match-tags",
    definition: {
      nodes: [
        { id: "t1", type: "trigger-webhook", config: {} },
        {
          id: "cm1",
          type: "code-match",
          config: {
            code: "(input) => input.trigger.tags && input.trigger.tags.includes('urgent')",
            outputPorts: ["true", "false"],
          },
        },
        {
          id: "ct1",
          type: "create-task",
          config: { template: "Urgent: {{trigger.title}}" },
        },
      ],
      edges: [
        { id: "e1", source: "t1", sourcePort: "default", target: "cm1" },
        { id: "e2", source: "cm1", sourcePort: "true", target: "ct1" },
      ],
    },
  },

  /** trigger-webhook → code-match that throws → should fail */
  failingCodeMatch: {
    name: "e2e-failing-code-match",
    definition: {
      nodes: [
        { id: "t1", type: "trigger-webhook", config: {} },
        {
          id: "cm1",
          type: "code-match",
          config: {
            code: '(input) => { throw new Error("intentional failure"); }',
            outputPorts: ["true", "false"],
          },
        },
      ],
      edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "cm1" }],
    },
  },

  /** trigger-webhook only (minimal, for edge-case tests) */
  minimal: {
    name: "e2e-minimal",
    definition: {
      nodes: [{ id: "t1", type: "trigger-webhook", config: {} }],
      edges: [],
    },
  },

  /** trigger-webhook → create-task (trivial task for worker E2E) */
  workerE2E: {
    name: "e2e-worker-flow",
    definition: {
      nodes: [
        { id: "t1", type: "trigger-webhook", config: {} },
        {
          id: "ct1",
          type: "create-task",
          config: {
            template:
              "Reply with ONLY the text 'E2E_OK' and nothing else. Do not use any tools. Just output E2E_OK.",
          },
        },
      ],
      edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "ct1" }],
    },
  },
};

// ─── Test Suites ────────────────────────────────────────────────────────────

interface WfJson {
  id: string;
  name: string;
  enabled: boolean;
  webhookSecret: string;
}
interface RunJson {
  id: string;
  runId: string;
}
interface RunDetailJson {
  id: string;
  status: string;
  steps: Array<{
    id: string;
    nodeId: string;
    status: string;
    error?: string;
    output?: unknown;
  }>;
}
interface TaskJson {
  id: string;
  status: string;
  task: string; // the task description field
  source: string;
  workflowRunId: string | null;
  workflowRunStepId: string | null;
  output?: string;
}

async function testWorkflowCrud() {
  log("Test: Workflow CRUD lifecycle");

  // Create
  const { status: createStatus, data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name: SCENARIOS.triagePriority.name,
    definition: SCENARIOS.triagePriority.definition,
  });
  assertEq(createStatus, 201, "Create workflow returns 201");
  assert(typeof wf.id === "string" && wf.id.length > 0, "Create workflow returns id");
  assertEq(wf.name, SCENARIOS.triagePriority.name, "Create workflow returns correct name");
  assertEq(wf.enabled, true, "Create workflow returns enabled=true");

  // List
  const { data: list } = await api<WfJson[]>("GET", "/api/workflows");
  assert(
    Array.isArray(list) && list.some((w) => w.id === wf.id),
    "List workflows contains created workflow",
  );

  // Get single
  const { status: getStatus, data: single } = await api<WfJson>("GET", `/api/workflows/${wf.id}`);
  assertEq(getStatus, 200, "Get workflow by id returns 200");
  assertEq(single.name, SCENARIOS.triagePriority.name, "Get workflow returns correct name");

  // Update
  const { data: updated } = await api<WfJson>("PUT", `/api/workflows/${wf.id}`, {
    name: "e2e-triage-updated",
  });
  assertEq(updated.name, "e2e-triage-updated", "Update workflow name");

  // 404 on unknown
  const { status: notFoundStatus } = await api("GET", "/api/workflows/nonexistent-id");
  assertEq(notFoundStatus, 404, "GET unknown workflow returns 404");

  return wf.id;
}

async function testTriggerHighPriority(workflowId: string) {
  log("Test: Trigger workflow (high priority → task created)");

  const { status, data } = await api<RunJson>("POST", `/api/workflows/${workflowId}/trigger`, {
    priority: 8,
    title: "Server is on fire",
  });
  assertEq(status, 201, "Trigger returns 201");
  assert(typeof data.runId === "string", "Trigger returns runId");

  // Wait for async execution
  await Bun.sleep(1000);

  const { data: run } = await api<RunDetailJson>("GET", `/api/workflow-runs/${data.runId}`);
  assert(Array.isArray(run.steps) && run.steps.length > 0, "Run has steps");

  // All 3 nodes should be visited: trigger, property-match, create-task
  assert(run.steps.length >= 3, `All 3 nodes executed (got ${run.steps.length} steps)`);

  // Run should be waiting (create-task is async) or completed
  assert(
    run.status === "waiting" || run.status === "completed",
    `Run status is waiting or completed (got ${run.status})`,
  );

  // Verify the create-task step actually created a real task
  const ctStep = run.steps.find((s) => s.nodeId === "ct1");
  const ctOutput = ctStep?.output as { taskId?: string } | undefined;
  assert(!!ctOutput?.taskId, "create-task step output contains taskId");

  if (ctOutput?.taskId) {
    const { status: taskStatus, data: task } = await api<TaskJson>(
      "GET",
      `/api/tasks/${ctOutput.taskId}`,
    );
    assertEq(taskStatus, 200, "Created task exists in DB");
    assertEq(task.source, "workflow", "Task source is 'workflow'");
    assert(
      task.task.includes("Server is on fire"),
      `Task description interpolated correctly: "${task.task}"`,
    );
    assertEq(task.workflowRunId, data.runId, "Task linked to workflow run");
  }

  // List runs
  const { data: runs } = await api<Array<{ id: string }>>(
    "GET",
    `/api/workflows/${workflowId}/runs`,
  );
  assert(
    Array.isArray(runs) && runs.some((r) => r.id === data.runId),
    "List runs contains our run",
  );

  return data.runId;
}

async function testTriggerLowPriority(workflowId: string) {
  log("Test: Trigger workflow (low priority → no task)");

  const { data } = await api<RunJson>("POST", `/api/workflows/${workflowId}/trigger`, {
    priority: 2,
    title: "Minor typo",
  });

  await Bun.sleep(500);

  const { data: run } = await api<RunDetailJson>("GET", `/api/workflow-runs/${data.runId}`);
  assertEq(run.status, "completed", "Low priority run completes (no async nodes reached)");

  // Only 2 steps: trigger + property-match (ct1 skipped because pm1 returned false)
  assertEq(run.steps.length, 2, "Only 2 nodes executed (trigger, property-match — task skipped)");
}

async function testDisabledWorkflow(workflowId: string) {
  log("Test: Disabled workflow returns 400");

  await api("PUT", `/api/workflows/${workflowId}`, { enabled: false });
  const { status } = await api("POST", `/api/workflows/${workflowId}/trigger`, {});
  assertEq(status, 400, "Trigger disabled workflow returns 400");

  // Re-enable
  await api("PUT", `/api/workflows/${workflowId}`, { enabled: true });
}

async function testCodeMatch() {
  log("Test: Code-match node execution");

  // Create code-match workflow
  const { data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name: SCENARIOS.codeMatchTags.name,
    definition: SCENARIOS.codeMatchTags.definition,
  });

  // Trigger with matching tags → should reach create-task
  const { data: run1 } = await api<RunJson>("POST", `/api/workflows/${wf.id}/trigger`, {
    tags: ["urgent", "bug"],
    title: "DB connection leak",
  });
  await Bun.sleep(500);
  const { data: detail1 } = await api<RunDetailJson>("GET", `/api/workflow-runs/${run1.runId}`);
  assert(
    detail1.steps.length >= 3,
    `Code-match true: all 3 nodes executed (got ${detail1.steps.length})`,
  );

  // Trigger without matching tags → should stop at code-match
  const { data: run2 } = await api<RunJson>("POST", `/api/workflows/${wf.id}/trigger`, {
    tags: ["minor"],
    title: "Typo in readme",
  });
  await Bun.sleep(500);
  const { data: detail2 } = await api<RunDetailJson>("GET", `/api/workflow-runs/${run2.runId}`);
  assertEq(
    detail2.steps.length,
    2,
    "Code-match false: only 2 nodes executed (trigger, code-match — task skipped)",
  );
  assertEq(detail2.status, "completed", "Code-match false run completed");

  // Cleanup
  await api("DELETE", `/api/workflows/${wf.id}`);
}

async function testFailedRunRetry() {
  log("Test: Failed run and retry");

  // Create workflow with code that throws
  const { data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name: SCENARIOS.failingCodeMatch.name,
    definition: SCENARIOS.failingCodeMatch.definition,
  });

  const { data: triggerData } = await api<RunJson>("POST", `/api/workflows/${wf.id}/trigger`, {});
  await Bun.sleep(500);

  const { data: run } = await api<RunDetailJson>("GET", `/api/workflow-runs/${triggerData.runId}`);
  assertEq(run.status, "failed", "Failing code-match marks run as failed");

  // Retry endpoint should respond (it will fail again since the code still throws)
  const { status: retryStatus } = await api(
    "POST",
    `/api/workflow-runs/${triggerData.runId}/retry`,
  );
  assert(
    retryStatus === 200 || retryStatus === 400,
    `Retry endpoint responds (status=${retryStatus})`,
  );

  // Cleanup
  await api("DELETE", `/api/workflows/${wf.id}`);
}

async function testWebhookSecretAuth() {
  log("Test: Webhook secret auth");

  // Create a minimal workflow to get its ID
  const { data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name: `e2e-secret-auth-${Date.now()}`,
    definition: SCENARIOS.minimal.definition,
  });

  // Trigger without X-Agent-ID and wrong secret → 401
  const { status } = await fetchNoAgent(
    "POST",
    `/api/workflows/${wf.id}/trigger?secret=wrong-secret`,
    {},
  );
  assertEq(status, 401, "Trigger without agentId and wrong secret returns 401");

  // Cleanup
  await api("DELETE", `/api/workflows/${wf.id}`);
}

async function testDeleteWorkflow(workflowId: string) {
  log("Test: Delete workflow");

  const { status: delStatus } = await api("DELETE", `/api/workflows/${workflowId}`);
  assertEq(delStatus, 204, "Delete workflow returns 204");

  const { status: getStatus } = await api("GET", `/api/workflows/${workflowId}`);
  assertEq(getStatus, 404, "Get deleted workflow returns 404");
}

async function testValidation() {
  log("Test: Validation");

  const { status } = await api("POST", "/api/workflows", {
    name: "bad-workflow",
    definition: { notValidAtAll: true },
  });
  assertEq(status, 400, "Invalid definition returns 400");
}

/** Poll a resource until a predicate is true or timeout */
async function pollUntil<T>(
  label: string,
  fetchFn: () => Promise<T>,
  predicate: (data: T) => boolean,
  timeoutMs = 300_000,
  intervalMs = 3_000,
): Promise<T | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const data = await fetchFn();
    if (predicate(data)) return data;
    const elapsed = Math.round((Date.now() - start) / 1000);
    process.stdout.write(`\r  \x1b[90m... ${label} (${elapsed}s)\x1b[0m`);
    await Bun.sleep(intervalMs);
  }
  process.stdout.write("\n");
  return null;
}

/**
 * Full end-to-end test: workflow engine → Docker worker → Claude runner → resume.
 *
 * Scenario: trigger-webhook → create-task (pre-assigned to worker agent)
 *
 * Verified flow:
 *   1. Create workflow with a create-task node that generates a trivial Claude task
 *   2. Trigger the workflow via HTTP — run enters "waiting" state
 *   3. create-task node creates a real agent_task in the DB, assigned to a Docker worker
 *   4. Docker worker picks up the task via /api/poll
 *   5. Claude inside the container executes the task (outputs "E2E_OK")
 *   6. Worker calls completeTask() → event bus emits "task.completed"
 *   7. Resume listener (setupWorkflowResumeListener) catches the event
 *   8. resumeFromTaskCompletion() marks the step completed and walks remaining DAG
 *   9. Workflow run transitions from "waiting" → "completed"
 *
 * This is the most important test — it validates the entire async workflow lifecycle
 * including the handoff between the workflow engine and the Claude worker runtime.
 */
async function testWorkerE2EFlow() {
  log("Test: Full E2E — workflow → task → worker picks up → task completes → run resumes");
  log("  (This test requires Docker workers and may take a few minutes)");

  // 0. Find a registered worker agent to pre-assign the task to
  const { data: agentsResp } = await api<{ agents: Array<{ id: string; role: string }> }>(
    "GET",
    "/api/agents",
  );
  const agents = agentsResp.agents ?? [];
  const workerAgent = agents.find((a) => a.role === "worker") ?? agents[0];
  assert(!!workerAgent, "Worker E2E: found registered agent for task assignment");
  if (!workerAgent) return;
  log(`  Using agent ${workerAgent.id} (role=${workerAgent.role}) for task assignment`);

  // 1. Create workflow with create-task pre-assigned to the worker agent
  const workerDef = {
    nodes: [
      { id: "t1", type: "trigger-webhook", config: {} },
      {
        id: "ct1",
        type: "create-task",
        config: {
          template:
            "Reply with ONLY the text 'E2E_OK' and nothing else. Do not use any tools. Just output E2E_OK.",
          agentId: workerAgent.id,
        },
      },
    ],
    edges: [{ id: "e1", source: "t1", sourcePort: "default", target: "ct1" }],
  };
  const { data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name: "e2e-worker-flow",
    definition: workerDef,
  });
  assert(!!wf.id, "Worker E2E: workflow created");

  // 2. Trigger the workflow
  const { data: triggerResult } = await api<RunJson>("POST", `/api/workflows/${wf.id}/trigger`, {});
  const runId = triggerResult.runId;
  assert(!!runId, "Worker E2E: workflow triggered, got runId");

  // 3. Wait a moment, then get the run to find the created task
  await Bun.sleep(1500);
  const { data: run } = await api<RunDetailJson>("GET", `/api/workflow-runs/${runId}`);
  assertEq(run.status, "waiting", "Worker E2E: run is in 'waiting' state");

  const ctStep = run.steps.find((s) => s.nodeId === "ct1");
  const ctOutput = ctStep?.output as { taskId?: string } | undefined;
  assert(!!ctOutput?.taskId, "Worker E2E: create-task produced a taskId");
  const taskId = ctOutput?.taskId;
  if (!taskId) {
    logFail("Worker E2E", "No taskId — cannot continue worker flow test");
    await api("DELETE", `/api/workflows/${wf.id}`);
    return;
  }

  // 4. Verify task exists
  const { data: task } = await api<TaskJson>("GET", `/api/tasks/${taskId}`);
  assert(
    ["pending", "in-progress", "in_progress", "unassigned"].includes(task.status),
    `Worker E2E: task initial status is '${task.status}'`,
  );

  // 5. Poll for task completion (worker picks it up, Claude runs it)
  log("  Waiting for worker to pick up and complete task...");
  const completedTask = await pollUntil<TaskJson>(
    "waiting for task completion",
    async () => (await api<TaskJson>("GET", `/api/tasks/${taskId}`)).data,
    (t) => t.status === "completed" || t.status === "failed" || t.status === "cancelled",
    300_000, // 5 min timeout
    5_000,
  );
  console.log(""); // clear the poll status line

  if (!completedTask) {
    logFail("Worker E2E: task completed within timeout", "Timed out after 5 minutes");
    await api("DELETE", `/api/workflows/${wf.id}`);
    return;
  }

  assertEq(completedTask.status, "completed", "Worker E2E: task completed successfully");
  log(`  Task output: "${(completedTask.output ?? "").slice(0, 100)}"`);

  // 6. Give the event bus a moment to fire the resume
  await Bun.sleep(2000);

  // 7. Verify workflow run resumed and completed
  const { data: finalRun } = await api<RunDetailJson>("GET", `/api/workflow-runs/${runId}`);
  assertEq(finalRun.status, "completed", "Worker E2E: workflow run completed after task finished");

  // Check all steps are completed
  const allStepsCompleted = finalRun.steps.every((s) => s.status === "completed");
  assert(allStepsCompleted, "Worker E2E: all workflow steps are completed");

  // Cleanup
  await api("DELETE", `/api/workflows/${wf.id}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  log("=== E2E Workflow Engine Test ===");
  log(`PORT=${PORT}  DB=${DB_PATH}  DOCKER=${WITH_DOCKER}`);

  try {
    // Step 0: Start API
    await startApi();

    // Step 1+2: Docker (optional)
    if (WITH_DOCKER) {
      await buildDocker();
      await spawnContainers();
    }

    // Step 3+4+5: Run test suites
    const workflowId = await testWorkflowCrud();
    await testTriggerHighPriority(workflowId);
    await testTriggerLowPriority(workflowId);
    await testDisabledWorkflow(workflowId);
    await testCodeMatch();
    await testFailedRunRetry();
    await testWebhookSecretAuth();
    await testValidation();
    await testDeleteWorkflow(workflowId);

    // Step 6: Full worker E2E (only with Docker)
    if (WITH_DOCKER) {
      await testWorkerE2EFlow();
    } else {
      log("Skipping worker E2E flow test (run with --with-docker to enable)");
    }
  } catch (err) {
    logFail("UNEXPECTED ERROR", String(err));
    console.error(err);
  } finally {
    // Step 6: Cleanup
    await cleanup();
  }

  // Summary
  console.log("");
  log("=========================================");
  log(`Results: ${pass} passed, ${fail} failed`);
  log("=========================================");

  process.exit(fail > 0 ? 1 : 0);
}

main();
