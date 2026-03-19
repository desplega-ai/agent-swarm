#!/usr/bin/env bun
/**
 * E2E Workflow I/O Schemas Test
 *
 * Spins up the full API server with a clean DB, then exercises:
 *   1. triggerSchema validation (missing, wrong type, valid)
 *   2. Node inputs mapping + data flow between nodes
 *   3. inputSchema validation
 *   4. Unresolved token diagnostics
 *   5. Static data flow validation (non-existent/downstream references)
 *   6. Deep interpolation (nested objects, arrays)
 *   7. Convergence with conditional branches
 *   8. Backward compatibility (no schemas)
 *   9. outputSchema validation
 *
 * Usage:
 *   bun scripts/e2e-io-schemas-test.ts
 *   E2E_PORT=13098 bun scripts/e2e-io-schemas-test.ts
 */
import { $, type Subprocess } from "bun";

// ─── Config ─────────────────────────────────────────────────────────────────
const PORT = process.env.E2E_PORT || "13098";
const API_KEY = process.env.API_KEY || "123123";
const BASE_URL = `http://localhost:${PORT}`;
const DB_PATH = `/tmp/e2e-io-schemas-${Date.now()}.sqlite`;
const AGENT_ID = crypto.randomUUID();

// ─── State ──────────────────────────────────────────────────────────────────
let apiProc: Subprocess | null = null;
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

  if (apiProc) {
    try {
      apiProc.kill("SIGTERM");
      await Bun.sleep(1000);
      if (apiProc.exitCode === null) apiProc.kill("SIGKILL");
    } catch {
      // already dead
    }
    apiProc = null;
  }

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

// ─── Start API ──────────────────────────────────────────────────────────────
async function startApi() {
  log(`Starting API server on port ${PORT} with DB at ${DB_PATH}...`);
  apiProc = Bun.spawn(["bun", "src/http.ts"], {
    cwd: `${import.meta.dir}/..`,
    env: {
      ...process.env,
      PORT,
      API_KEY,
      DATABASE_PATH: DB_PATH,
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      HEARTBEAT_DISABLE: "true",
      AGENTMAIL_DISABLE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
  });

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

// ─── Response Types ─────────────────────────────────────────────────────────
interface WfJson {
  id: string;
  name: string;
  enabled: boolean;
}
interface TriggerJson {
  runId: string;
}
interface RunJson {
  run: {
    id: string;
    status: string;
    error?: string;
  };
  steps: Array<{
    id: string;
    nodeId: string;
    status: string;
    error?: string;
    output?: unknown;
    diagnostics?: string;
  }>;
}

// ─── Helper: create, trigger, wait, fetch run ───────────────────────────────
async function createAndTrigger(
  name: string,
  definition: unknown,
  triggerData: unknown,
  extra: Record<string, unknown> = {},
): Promise<{ wfId: string; runId: string; run: RunJson }> {
  const { data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name,
    definition,
    ...extra,
  });
  const { status, data: triggerResult } = await api<TriggerJson>(
    "POST",
    `/api/workflows/${wf.id}/trigger`,
    triggerData,
  );
  if (status !== 201) {
    return {
      wfId: wf.id,
      runId: "",
      run: { run: { id: "", status: "trigger_failed", error: `status ${status}` }, steps: [] },
    };
  }
  // Wait for async execution
  await Bun.sleep(2000);
  const { data: run } = await api<RunJson>("GET", `/api/workflow-runs/${triggerResult.runId}`);
  return { wfId: wf.id, runId: triggerResult.runId, run };
}

// ─── Test 1: triggerSchema ──────────────────────────────────────────────────

async function testTriggerSchema() {
  log("Test 1: triggerSchema validation");

  const triggerSchema = {
    type: "object",
    properties: {
      repo: { type: "string" },
      priority: { type: "number" },
    },
    required: ["repo"],
  };

  const definition = {
    nodes: [
      {
        id: "echo",
        type: "script",
        inputs: { repo: "trigger.repo" },
        config: { runtime: "bash", script: "echo {{repo}}" },
      },
    ],
  };

  // Create workflow with triggerSchema
  const { data: wf } = await api<WfJson>("POST", "/api/workflows", {
    name: "e2e-trigger-schema",
    definition,
    triggerSchema,
  });
  assert(!!wf.id, "1a. Created workflow with triggerSchema");

  // Trigger with missing required field "repo" -> 400
  const { status: s1 } = await api("POST", `/api/workflows/${wf.id}/trigger`, {
    priority: 5,
  });
  assertEq(s1, 400, "1b. Trigger with missing repo returns 400");

  // Trigger with wrong type repo: 123 (number instead of string) -> 400
  const { status: s2 } = await api("POST", `/api/workflows/${wf.id}/trigger`, {
    repo: 123,
  });
  assertEq(s2, 400, "1c. Trigger with repo=123 (wrong type) returns 400");

  // Trigger with valid payload -> 201
  const { status: s3, data: trigResult } = await api<TriggerJson>(
    "POST",
    `/api/workflows/${wf.id}/trigger`,
    { repo: "my-repo", priority: 3 },
  );
  assertEq(s3, 201, "1d. Trigger with valid payload returns 201");
  assert(typeof trigResult.runId === "string" && trigResult.runId.length > 0, "1e. Got runId");

  // Wait and verify run executed
  await Bun.sleep(2000);
  const { data: run } = await api<RunJson>("GET", `/api/workflow-runs/${trigResult.runId}`);
  assertEq(run.run.status, "completed", "1f. Valid trigger run completed");

  // Verify the script output contains the repo value
  const echoStep = run.steps.find((s) => s.nodeId === "echo");
  const echoOutput = echoStep?.output as { stdout?: string } | undefined;
  assert(
    echoOutput?.stdout?.includes("my-repo") ?? false,
    "1g. Script output contains repo value",
    `got stdout: ${echoOutput?.stdout}`,
  );

  // Cleanup
  await api("DELETE", `/api/workflows/${wf.id}`);
}

// ─── Test 2: Node inputs mapping + data flow ────────────────────────────────

async function testInputsMappingDataFlow() {
  log("Test 2: Node inputs mapping + data flow");

  const definition = {
    nodes: [
      {
        id: "fetch",
        type: "script",
        inputs: { repo: "trigger.repo" },
        config: { runtime: "bash", script: "echo {{repo}}" },
        next: "process",
      },
      {
        id: "process",
        type: "script",
        inputs: { code: "fetch.stdout" },
        config: { runtime: "bash", script: "echo processed: {{code}}" },
      },
    ],
  };

  const { run, wfId } = await createAndTrigger("e2e-inputs-flow", definition, {
    repo: "agent-swarm",
  });

  assertEq(run.run.status, "completed", "2a. Data flow run completed");
  assert(run.steps.length >= 2, "2b. Both steps executed");

  // Check fetch step
  const fetchStep = run.steps.find((s) => s.nodeId === "fetch");
  const fetchOutput = fetchStep?.output as { stdout?: string } | undefined;
  assert(
    fetchOutput?.stdout?.includes("agent-swarm") ?? false,
    "2c. Fetch step output contains trigger value",
    `got stdout: ${fetchOutput?.stdout}`,
  );

  // Check process step - should contain the fetch output passed through
  const processStep = run.steps.find((s) => s.nodeId === "process");
  const processOutput = processStep?.output as { stdout?: string } | undefined;
  assert(
    processOutput?.stdout?.includes("agent-swarm") ?? false,
    "2d. Process step output contains trigger value passed through fetch",
    `got stdout: ${processOutput?.stdout}`,
  );
  assert(
    processOutput?.stdout?.includes("processed:") ?? false,
    "2e. Process step output has 'processed:' prefix",
    `got stdout: ${processOutput?.stdout}`,
  );

  await api("DELETE", `/api/workflows/${wfId}`);
}

// ─── Test 3: inputSchema validation ─────────────────────────────────────────

async function testInputSchemaValidation() {
  log("Test 3: inputSchema validation");

  const definition = {
    nodes: [
      {
        id: "greet",
        type: "script",
        inputs: { msg: "trigger.msg" },
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        config: { runtime: "bash", script: "echo {{msg}}" },
      },
    ],
  };

  // 3a. Trigger with valid input { msg: "hello" } -> success
  const { run: run1, wfId: wfId1 } = await createAndTrigger("e2e-input-schema-valid", definition, {
    msg: "hello",
  });
  assertEq(run1.run.status, "completed", "3a. Valid inputSchema run completed");
  const greetStep1 = run1.steps.find((s) => s.nodeId === "greet");
  const greetOutput1 = greetStep1?.output as { stdout?: string } | undefined;
  assert(
    greetOutput1?.stdout?.includes("hello") ?? false,
    "3b. Valid input produces correct output",
    `got stdout: ${greetOutput1?.stdout}`,
  );
  await api("DELETE", `/api/workflows/${wfId1}`);

  // 3c. Trigger with wrong type { msg: 123 } -> step should fail
  // The inputSchema checks the interpolation context which includes trigger.msg
  // Since the node has inputs: { msg: "trigger.msg" }, the resolved value will
  // be number 123, and the inputSchema requires msg to be string
  const definitionStrict = {
    nodes: [
      {
        id: "greet",
        type: "script",
        inputs: { msg: "trigger.msg" },
        inputSchema: {
          type: "object",
          properties: { msg: { type: "string" } },
          required: ["msg"],
        },
        config: { runtime: "bash", script: "echo {{msg}}" },
      },
    ],
  };

  const { run: run2, wfId: wfId2 } = await createAndTrigger(
    "e2e-input-schema-invalid",
    definitionStrict,
    { msg: 123 },
  );
  assertEq(run2.run.status, "failed", "3c. Invalid inputSchema run failed");
  const greetStep2 = run2.steps.find((s) => s.nodeId === "greet");
  assert(
    greetStep2?.status === "failed",
    "3d. Greet step failed on inputSchema violation",
    `got status: ${greetStep2?.status}`,
  );
  assert(
    greetStep2?.error?.includes("Input schema validation failed") ?? false,
    "3e. Error message mentions input schema validation",
    `got error: ${greetStep2?.error}`,
  );
  await api("DELETE", `/api/workflows/${wfId2}`);
}

// ─── Test 4: Unresolved token diagnostics ───────────────────────────────────

async function testUnresolvedTokenDiagnostics() {
  log("Test 4: Unresolved token diagnostics");

  const definition = {
    nodes: [
      {
        id: "echo",
        type: "script",
        inputs: { missing: "trigger.nonexistent" },
        config: { runtime: "bash", script: "echo val={{missing}}" },
      },
    ],
  };

  const { run, wfId } = await createAndTrigger("e2e-unresolved-tokens", definition, {
    existing: "yes",
  });

  // The step should still complete (unresolved tokens are warnings, not errors)
  assertEq(run.run.status, "completed", "4a. Run completes despite unresolved tokens");

  const echoStep = run.steps.find((s) => s.nodeId === "echo");
  assert(echoStep !== undefined, "4b. Echo step exists");

  // Check diagnostics field contains unresolvedTokens
  if (echoStep?.diagnostics) {
    const diag = JSON.parse(echoStep.diagnostics);
    assert(
      Array.isArray(diag.unresolvedTokens) && diag.unresolvedTokens.length > 0,
      "4c. Diagnostics contains unresolvedTokens",
      `got diagnostics: ${echoStep.diagnostics}`,
    );
  } else {
    // The token "missing" resolves to undefined (trigger.nonexistent doesn't exist),
    // so {{missing}} in the script template would be unresolved
    logFail("4c. Diagnostics contains unresolvedTokens", "diagnostics field is empty/null");
  }

  await api("DELETE", `/api/workflows/${wfId}`);
}

// ─── Test 5: Static data flow validation ────────────────────────────────────

async function testStaticDataFlowValidation() {
  log("Test 5: Static data flow validation");

  // 5a. Reference a non-existent node -> 400
  const { status: s1, data: d1 } = await api<{ error?: string }>("POST", "/api/workflows", {
    name: "e2e-bad-ref-nonexistent",
    definition: {
      nodes: [
        {
          id: "step1",
          type: "script",
          inputs: { data: "nonexistent_node.output" },
          config: { runtime: "bash", script: "echo {{data}}" },
        },
      ],
    },
  });
  assertEq(s1, 400, "5a. Non-existent node reference returns 400");
  assert(
    typeof d1?.error === "string" && d1.error.includes("non-existent node"),
    "5b. Error message mentions non-existent node",
    `got error: ${d1?.error}`,
  );

  // 5c. Reference a downstream node (not upstream) -> 400
  // step1 -> step2, but step2 tries to reference step1's sibling "step3"
  // which is a parallel node (not upstream)
  const { status: s2, data: d2 } = await api<{ error?: string }>("POST", "/api/workflows", {
    name: "e2e-bad-ref-downstream",
    definition: {
      nodes: [
        {
          id: "step1",
          type: "script",
          inputs: { data: "step2.stdout" },
          config: { runtime: "bash", script: "echo {{data}}" },
          next: "step2",
        },
        {
          id: "step2",
          type: "script",
          config: { runtime: "bash", script: "echo done" },
        },
      ],
    },
  });
  assertEq(s2, 400, "5c. Downstream node reference returns 400");
  assert(
    typeof d2?.error === "string" && d2.error.includes("not upstream"),
    "5d. Error message mentions not upstream",
    `got error: ${d2?.error}`,
  );

  // 5e. Valid upstream reference -> 201
  const { status: s3 } = await api<WfJson>("POST", "/api/workflows", {
    name: "e2e-valid-upstream-ref",
    definition: {
      nodes: [
        {
          id: "step1",
          type: "script",
          config: { runtime: "bash", script: "echo hello" },
          next: "step2",
        },
        {
          id: "step2",
          type: "script",
          inputs: { data: "step1.stdout" },
          config: { runtime: "bash", script: "echo {{data}}" },
        },
      ],
    },
  });
  assertEq(s3, 201, "5e. Valid upstream reference returns 201");
}

// ─── Test 6: Deep interpolation ─────────────────────────────────────────────

async function testDeepInterpolation() {
  log("Test 6: Deep interpolation (nested objects + arrays in config)");

  // The script executor only looks at config.script, config.runtime, etc.
  // But the deep interpolation happens on the entire config object.
  // We'll verify by using a script that echoes something based on the config,
  // and also verify the step completes (meaning interpolation didn't break).
  //
  // We can test deep interpolation by passing nested values through inputs
  // and interpolating them in the script.
  const definition = {
    nodes: [
      {
        id: "echo",
        type: "script",
        inputs: { name: "trigger.name", tag: "trigger.tag" },
        config: {
          runtime: "bash",
          script: "echo name={{name}} tag={{tag}}",
          // These nested fields are not used by the script executor but
          // they will be deep-interpolated by the engine
          nested: { val: "{{name}}" },
          list: ["{{tag}}", "fixed"],
        },
      },
    ],
  };

  const { run, wfId } = await createAndTrigger("e2e-deep-interpolation", definition, {
    name: "TestName",
    tag: "v1.0",
  });

  assertEq(run.run.status, "completed", "6a. Deep interpolation run completed");

  const echoStep = run.steps.find((s) => s.nodeId === "echo");
  const echoOutput = echoStep?.output as { stdout?: string } | undefined;
  assert(
    echoOutput?.stdout?.includes("name=TestName") ?? false,
    "6b. Script output contains interpolated name",
    `got stdout: ${echoOutput?.stdout}`,
  );
  assert(
    echoOutput?.stdout?.includes("tag=v1.0") ?? false,
    "6c. Script output contains interpolated tag",
    `got stdout: ${echoOutput?.stdout}`,
  );

  await api("DELETE", `/api/workflows/${wfId}`);
}

// ─── Test 7: Convergence with conditional branches ──────────────────────────

async function testConvergenceConditionalBranches() {
  log("Test 7: Convergence with conditional branches");

  // Workflow: A (code-match, branches true/false) ->
  //   true:  B (script) -> C (script)
  //   false: C (script)
  // C converges from both paths.

  const definition = {
    nodes: [
      {
        id: "A",
        type: "code-match",
        config: {
          code: "(input) => input.trigger && input.trigger.match === true",
          outputPorts: ["true", "false"],
        },
        next: { true: "B", false: "C" },
      },
      {
        id: "B",
        type: "script",
        config: { runtime: "bash", script: "echo branch-B" },
        next: "C",
      },
      {
        id: "C",
        type: "script",
        config: { runtime: "bash", script: "echo final-C" },
      },
    ],
  };

  // 7a. Trigger with match=true -> A, B, C all execute
  const { run: run1, wfId: wfId1 } = await createAndTrigger("e2e-convergence-true", definition, {
    match: true,
  });
  assertEq(run1.run.status, "completed", "7a. Convergence (true path) run completed");
  const stepIds1 = run1.steps.map((s) => s.nodeId);
  assert(stepIds1.includes("A"), "7b. Node A executed (true path)");
  assert(stepIds1.includes("B"), "7c. Node B executed (true path)");
  assert(stepIds1.includes("C"), "7d. Node C executed (true path)");
  await api("DELETE", `/api/workflows/${wfId1}`);

  // 7e. Trigger with match=false -> A, C execute (B skipped)
  const { run: run2, wfId: wfId2 } = await createAndTrigger("e2e-convergence-false", definition, {
    match: false,
  });
  assertEq(run2.run.status, "completed", "7e. Convergence (false path) run completed");
  const stepIds2 = run2.steps.map((s) => s.nodeId);
  assert(stepIds2.includes("A"), "7f. Node A executed (false path)");
  assert(!stepIds2.includes("B"), "7g. Node B NOT executed (false path, skipped)");
  assert(stepIds2.includes("C"), "7h. Node C executed (false path, converged)");
  await api("DELETE", `/api/workflows/${wfId2}`);
}

// ─── Test 8: Backward compatibility ─────────────────────────────────────────

async function testBackwardCompatibility() {
  log("Test 8: Backward compatibility (no triggerSchema, no inputs, no inputSchema)");

  const definition = {
    nodes: [
      {
        id: "echo",
        type: "script",
        // No inputs, no inputSchema, no outputSchema
        config: { runtime: "bash", script: "echo hello-compat" },
      },
    ],
  };

  // No triggerSchema -> any payload accepted
  const { run, wfId } = await createAndTrigger("e2e-backward-compat", definition, {
    anything: "goes",
    nested: { value: 42 },
  });

  assertEq(run.run.status, "completed", "8a. Backward-compat run completed");
  const echoStep = run.steps.find((s) => s.nodeId === "echo");
  const echoOutput = echoStep?.output as { stdout?: string } | undefined;
  assertEq(echoOutput?.stdout, "hello-compat", "8b. Script executed correctly");

  await api("DELETE", `/api/workflows/${wfId}`);
}

// ─── Test 9: outputSchema validation ────────────────────────────────────────

async function testOutputSchemaValidation() {
  log("Test 9: outputSchema validation");

  // Script executor outputs { exitCode: number, stdout: string, stderr: string }
  // We'll define an outputSchema that matches this shape -> should succeed

  const definition = {
    nodes: [
      {
        id: "echo",
        type: "script",
        outputSchema: {
          type: "object",
          properties: {
            exitCode: { type: "number" },
          },
          required: ["exitCode"],
        },
        config: { runtime: "bash", script: "echo ok" },
      },
    ],
  };

  const { run: run1, wfId: wfId1 } = await createAndTrigger(
    "e2e-output-schema-valid",
    definition,
    {},
  );
  assertEq(run1.run.status, "completed", "9a. OutputSchema (valid) run completed");
  const echoStep = run1.steps.find((s) => s.nodeId === "echo");
  assertEq(echoStep?.status, "completed", "9b. Echo step completed with matching outputSchema");
  await api("DELETE", `/api/workflows/${wfId1}`);

  // 9c. Define an outputSchema that expects a string where there's a number
  // Script executor returns exitCode as number, but we require it to be string -> should fail
  const definitionBad = {
    nodes: [
      {
        id: "echo",
        type: "script",
        outputSchema: {
          type: "object",
          properties: {
            exitCode: { type: "string" },
          },
          required: ["exitCode"],
        },
        config: { runtime: "bash", script: "echo ok" },
      },
    ],
  };

  const { run: run2, wfId: wfId2 } = await createAndTrigger(
    "e2e-output-schema-invalid",
    definitionBad,
    {},
  );
  assertEq(run2.run.status, "failed", "9c. OutputSchema (invalid) run failed");
  const echoStep2 = run2.steps.find((s) => s.nodeId === "echo");
  assert(
    echoStep2?.status === "failed",
    "9d. Echo step failed on outputSchema violation",
    `got status: ${echoStep2?.status}`,
  );
  assert(
    echoStep2?.error?.includes("Output schema validation failed") ?? false,
    "9e. Error message mentions output schema validation",
    `got error: ${echoStep2?.error}`,
  );
  await api("DELETE", `/api/workflows/${wfId2}`);
}

// ─── Main ───────────────────────────────────────────────────────────────────
async function main() {
  log("=== E2E Workflow I/O Schemas Test ===");
  log(`PORT=${PORT}  DB=${DB_PATH}`);

  try {
    await startApi();

    await testTriggerSchema();
    await testInputsMappingDataFlow();
    await testInputSchemaValidation();
    await testUnresolvedTokenDiagnostics();
    await testStaticDataFlowValidation();
    await testDeepInterpolation();
    await testConvergenceConditionalBranches();
    await testBackwardCompatibility();
    await testOutputSchemaValidation();
  } catch (err) {
    logFail("UNEXPECTED ERROR", String(err));
    console.error(err);
  } finally {
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
