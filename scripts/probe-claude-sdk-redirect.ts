import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerVolatileSecret, scrubSecrets } from "../src/utils/secret-scrubber";
import { asRecord, createApiClient, expect, expectStatus, pollUntil } from "./e2e/http";
import { minimalEnv, repoRoot, startSut, stopSut } from "./e2e/sut";

// Opt-in live probe: real API, worker, SDK and model. Credentials stay on the worker.
// RUN_CLAUDE_SDK_REDIRECT=1 bun scripts/probe-claude-sdk-redirect.ts
expect(process.env.RUN_CLAUDE_SDK_REDIRECT === "1", "Set RUN_CLAUDE_SDK_REDIRECT=1");
const routeEnv: Record<string, string> = {};
for (const key of [
  "ANTHROPIC_API_KEY",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
]) {
  if (process.env[key]) routeEnv[key] = process.env[key]!;
}
for (const key of ["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN"]) {
  if (routeEnv[key]) registerVolatileSecret(routeEnv[key], "live-probe-credential");
}
expect(
  Object.keys(routeEnv).some((key) => /TOKEN|API_KEY/.test(key)),
  "Supply Claude credentials through the environment",
);
const directory = await mkdtemp(join(tmpdir(), "claude-sdk-redirect-"));
const home = join(directory, "home");
const workspace = join(directory, "workspace");
await mkdir(home, { recursive: true });
await mkdir(workspace);
const executable = process.env.CLAUDE_SDK_LIFECYCLE_BINARY || Bun.which("claude");
expect(executable, "Install Claude Code or set CLAUDE_SDK_LIFECYCLE_BINARY");
let sut: Awaited<ReturnType<typeof startSut>> | undefined;
let worker: Bun.Subprocess | undefined;
let drains: Promise<unknown> | undefined;
let taskId: string | undefined;
const evidence: Record<string, unknown> = { passed: false };
const writer = Bun.file(join(directory, "worker.log")).writer();
try {
  await mkdir(join(home, ".claude/skills/work-on-task"), { recursive: true });
  await Bun.write(
    join(home, ".claude/skills/work-on-task/SKILL.md"),
    await Bun.file(join(repoRoot, "templates/skills/work-on-task/content.md")).text(),
  );
  await Bun.write(
    join(workspace, "hold.ts"),
    `const child = Bun.spawn(['/bin/sleep','120'], {stdin:'ignore',stdout:'ignore',stderr:'ignore'});\nawait Bun.write('ready.json', JSON.stringify({toolPid:process.pid, childPid:child.pid}));\nawait child.exited;\nawait Bun.write('wrong-path','original tool finished');\n`,
  );
  sut = await startSut(false, { SLACK_DISABLE: "true" }, { STEERING_ENABLED: "true" });
  registerVolatileSecret(sut.apiKey, "swarm");
  const api = createApiClient(sut.baseUrl, sut.apiKey);
  const registered = await api("POST", "/api/agents", {
    body: {
      name: "SDK redirect verification",
      role: "worker",
      status: "online",
      harness_provider: "claude",
    },
  });
  expectStatus(registered, [201], "register");
  const agentId = String(asRecord(registered.json).id);
  await Bun.write(
    join(workspace, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "agent-swarm": {
          type: "http",
          url: `${sut.baseUrl}/mcp`,
          headers: { Authorization: `Bearer ${sut.apiKey}`, "X-Agent-ID": agentId },
        },
      },
    }),
  );
  expectStatus(
    await api("PUT", "/api/config", {
      body: { scope: "agent", scopeId: agentId, key: "CLAUDE_TRANSPORT", value: "sdk" },
    }),
    [200],
    "SDK config",
  );
  const created = await api("POST", "/api/tasks", {
    body: {
      agentId,
      routingReason: "human_pinned",
      source: "api",
      dir: workspace,
      task: "First use Bash to run exactly: bun hold.ts. Wait for it to finish. New instructions will arrive through Swarm. Follow those instructions and acknowledge every steering message with accept-steer. Only mark the task completed with store-progress after both new instructions are handled. Do not restart an interrupted command. Do not read unrelated files or contact external services.",
    },
  });
  expectStatus(created, [201], "create");
  taskId = String(asRecord(created.json).id);
  worker = Bun.spawn([process.execPath, "run", "src/cli.tsx", "worker", "--yolo"], {
    cwd: repoRoot,
    env: {
      ...minimalEnv(),
      ...routeEnv,
      HOME: home,
      CLAUDE_CONFIG_DIR: join(home, ".claude"),
      CLAUDE_TRUST_PRESEED: "false",
      LOG_DIR: join(directory, "logs"),
      AGENT_SWARM_API_KEY: sut.apiKey,
      MCP_BASE_URL: sut.baseUrl,
      AGENT_ID: agentId,
      SESSION_ID: crypto.randomUUID(),
      HARNESS_PROVIDER: "claude",
      CLAUDE_TRANSPORT: "sdk",
      CLAUDE_BINARY: executable,
      CLAUDECODE: "",
      MODEL_OVERRIDE: "claude-haiku-4-5",
      MAX_CONCURRENT_TASKS: "1",
      STEERING_ENABLED: "true",
      CLAUDE_QUEUE_STEERING: "1",
      SWARM_USE_CLAUDE_BRIDGE: "0",
      CONTEXT_MODE_DISABLED: "true",
      DISABLE_AUTOUPDATER: "1",
      STARTUP_SCRIPT_STRICT: "false",
      ANONYMIZED_TELEMETRY: "false",
      DESPLEGA_TELEMETRY_ENV: "test",
      SLACK_DISABLE: "true",
      GITHUB_DISABLE: "true",
      LINEAR_DISABLE: "true",
      JIRA_DISABLE: "true",
      AGENTMAIL_DISABLE: "true",
    },
    stdout: "pipe",
    stderr: "pipe",
    timeout: 180_000,
  });
  drains = Promise.all(
    [worker.stdout, worker.stderr].map(async (stream) => {
      for await (const chunk of stream as ReadableStream<Uint8Array>)
        writer.write(scrubSecrets(new TextDecoder().decode(chunk)));
    }),
  );
  expect(
    await pollUntil(() => Bun.file(join(workspace, "ready.json")).exists(), 60_000, 100),
    "tool did not start",
  );
  const pids = await Bun.file(join(workspace, "ready.json")).json();
  evidence.pids = pids;
  const active = asRecord((await api("GET", `/api/tasks/${taskId}`)).json);
  evidence.initialSessionId = active.claudeSessionId;
  evidence.capabilities = active.supportedSteerModes;
  const markers = [crypto.randomUUID(), crypto.randomUUID()];
  const started = performance.now();
  const rows = await Promise.all(
    markers.map(async (marker, index) => {
      const response = await api("POST", `/api/tasks/${taskId}/steer`, {
        body: {
          mode: index === 0 ? "queue" : "steer",
          onUnsupported: "fail",
          message: `${index === 1 ? "Stop the running hold.ts command and change course. " : ""}Write exactly ${marker} to action-${index}.txt. Acknowledge this message using accept-steer with its exact steering ID. Finish only after both action files are written and both steering IDs are acknowledged.`,
        },
      });
      expectStatus(response, [200], "steer");
      return asRecord(response.json);
    }),
  );
  evidence.rows = rows;
  const isRunning = async (pid: number) => {
    const p = Bun.spawn(["/bin/ps", "-p", String(pid), "-o", "stat="], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const status = (await new Response(p.stdout).text()).trim();
    await p.exited;
    return status !== "" && !status.startsWith("Z");
  };
  expect(
    await pollUntil(
      async () => !(await isRunning(pids.toolPid)) && !(await isRunning(pids.childPid)),
      15_000,
      100,
    ),
    "interrupted tool/child survived",
  );
  evidence.toolStoppedMs = Math.round(performance.now() - started);
  expect(
    !(await Bun.file(join(workspace, "wrong-path")).exists()),
    "old tool completed instead of interrupted",
  );
  const readMessages = async () =>
    asRecord((await api("GET", `/api/tasks/${taskId}/steering-messages`)).json).messages as Array<
      Record<string, unknown>
    >;
  expect(
    await pollUntil(
      async () => {
        const messages = await readMessages();
        return messages.length === 2 && messages.every((m) => m.status === "handled");
      },
      90_000,
      250,
    ),
    "steering not handled",
  );
  evidence.messages = await readMessages();
  for (let i = 0; i < 2; i++)
    expect(
      (await Bun.file(join(workspace, `action-${i}.txt`)).text()).trim() === markers[i],
      "changed action missing",
    );
  expect(
    await pollUntil(
      async () => asRecord((await api("GET", `/api/tasks/${taskId}`)).json).status === "completed",
      30_000,
      250,
    ),
    "task not completed",
  );
  const final = asRecord((await api("GET", `/api/tasks/${taskId}`)).json);
  expect(final.claudeSessionId === active.claudeSessionId, "session changed");
  evidence.finalSessionId = final.claudeSessionId;
  expect(
    Number(final.peakContextTokens) > 0 && Number(final.contextWindowSize) > 0,
    "persisted context missing",
  );
  evidence.contextTokens = final.peakContextTokens;
  expect(
    await pollUntil(
      async () => {
        const sessions = asRecord(
          (await api("GET", `/api/active-sessions?agentId=${agentId}`)).json,
        ).sessions as Array<Record<string, unknown>>;
        return !sessions.some((session) => session.taskId === taskId);
      },
      30_000,
      250,
    ),
    "worker did not finish session cleanup",
  );
  evidence.sessionCleanedUp = true;
  expect(
    await pollUntil(
      async () => {
        const costs = asRecord((await api("GET", `/api/session-costs?taskId=${taskId}`)).json)
          .costs as Array<Record<string, unknown>>;
        evidence.costs = costs;
        return costs.some(
          (cost) =>
            Number(cost.inputTokens) > 0 && Number(cost.outputTokens) > 0 && cost.isError === false,
        );
      },
      30_000,
      250,
    ),
    "persisted costs missing",
  );
  const logs = asRecord((await api("GET", `/api/tasks/${taskId}/session-logs?limit=1000`)).json)
    .logs as Array<Record<string, unknown>>;
  const acknowledged: string[] = [];
  for (const row of logs) {
    try {
      const message = JSON.parse(String(row.content));
      for (const block of message.message?.content ?? [])
        if (
          block.type === "tool_use" &&
          block.name?.endsWith("accept-steer") &&
          block.input?.steeringMessageId
        )
          acknowledged.push(block.input.steeringMessageId);
    } catch {}
  }
  expect(
    rows.every((r) => acknowledged.includes(String(r.steeringMessageId))),
    "missing actual accept-steer calls",
  );
  evidence.acknowledged = acknowledged;
  evidence.passed = true;
} catch (error) {
  evidence.error = scrubSecrets(String(error));
} finally {
  if (sut && taskId)
    await createApiClient(sut.baseUrl, sut.apiKey)("POST", `/api/tasks/${taskId}/cancel`).catch(
      () => {},
    );
  if (worker?.exitCode === null) {
    worker.kill("SIGTERM");
    await Promise.race([worker.exited, Bun.sleep(5000)]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
    await worker.exited;
  }
  await drains;
  await writer.end();
  if (sut) await stopSut(sut, false);
  if (!evidence.passed)
    evidence.workerLogTail = scrubSecrets(
      (await Bun.file(join(directory, "worker.log")).text()).slice(-8000),
    );
  if (process.env.CLAUDE_SDK_REDIRECT_RESULT)
    await Bun.write(
      process.env.CLAUDE_SDK_REDIRECT_RESULT,
      scrubSecrets(JSON.stringify(evidence, null, 2)),
    );
  await rm(directory, { recursive: true, force: true });
}
console.log(scrubSecrets(JSON.stringify(evidence)));
process.exitCode = evidence.passed ? 0 : 1;
