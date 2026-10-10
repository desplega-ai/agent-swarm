/**
 * API drain with a real worker. A real API and a real worker runner (driving a
 * fixture `claude` that never finishes its task) run together. The API gets
 * SIGTERM, as on a deploy. The worker must hand the task off while the API is
 * still up, and the API must exit on that handoff, not at its cap.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ApiClient,
  asRecord,
  createApiClient,
  expectStatus,
  pollUntil,
} from "../../scripts/e2e/http";
import { minimalEnv, repoRoot, type Sut, startSut, stopSut } from "../../scripts/e2e/sut";
import { scrubSecrets } from "../utils/secret-scrubber";

const AGENT_ID = "1b111111-1111-4111-8111-111111111111";
const SESSION_ID = "1b333333-3333-4333-8333-333333333333";
const FIXTURE_OAUTH = "synthetic-fixture-oauth-token";
const FIXTURE_API_KEY = "example-synthetic-fixture-anthropic-api-key";
const DRAIN_CAP_MS = 60_000;

let sut: Sut;
let api: ApiClient;
let fixtureDir: string;
let fixturePath: string;
let pm2StubPath: string;

/** A `claude` that initializes, accepts the prompt, and then never answers. */
const hangingFixtureSource = `#!/usr/bin/env bun
const sessionId = ${JSON.stringify(SESSION_ID)};
const argv = process.argv.slice(2);
if (argv.includes("--version")) {
  console.log("2.1.263 (Claude Code)");
  process.exit(0);
}
const emit = (value) => console.log(JSON.stringify(value));
let initialized = false;
let buffer = "";
const decoder = new TextDecoder();
for await (const chunk of Bun.stdin.stream()) {
  buffer += decoder.decode(chunk);
  let newline = buffer.indexOf("\\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline);
    buffer = buffer.slice(newline + 1);
    newline = buffer.indexOf("\\n");
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.type === "control_request") {
      emit({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
      if (message.request?.subtype === "initialize" && !initialized) {
        initialized = true;
        emit({ type: "system", subtype: "init", session_id: sessionId, model: "claude-haiku-4-5", uuid: crypto.randomUUID() });
      }
    }
    // A "user" message is the task prompt: take it and never finish.
  }
}
`;

async function waitForTask(taskId: string, predicate: (task: Record<string, unknown>) => boolean) {
  let latest: Record<string, unknown> = {};
  const found = await pollUntil(
    async () => {
      try {
        const response = await api("GET", `/api/tasks/${taskId}`);
        if (response.status !== 200) return false;
        latest = asRecord(response.json);
        return predicate(latest);
      } catch {
        return false; // the API is gone
      }
    },
    60_000,
    200,
  );
  if (!found) throw new Error(`Timed out waiting on task ${taskId}: ${JSON.stringify(latest)}`);
  return latest;
}

describe("API drain with a real worker", () => {
  beforeAll(async () => {
    fixtureDir = await mkdtemp("/tmp/api-drain-worker-");
    fixturePath = join(fixtureDir, "claude-fixture");
    pm2StubPath = join(fixtureDir, "bin");
    await Bun.$`mkdir -p ${pm2StubPath}`.quiet();
    await Bun.write(fixturePath, hangingFixtureSource);
    await Bun.write(join(pm2StubPath, "pm2"), "#!/bin/sh\nexit 0\n");
    await Bun.$`chmod 755 ${fixturePath}`.quiet();
    await Bun.$`chmod 755 ${join(pm2StubPath, "pm2")}`.quiet();
    sut = await startSut(
      false,
      {},
      { SLACK_DISABLE: "true", API_DRAIN_MAX_MS: String(DRAIN_CAP_MS) },
    );
    api = createApiClient(sut.baseUrl, sut.apiKey);
  }, 75_000);

  afterAll(async () => {
    if (sut) await stopSut(sut, false);
    if (fixtureDir) await rm(fixtureDir, { recursive: true, force: true });
  });

  test("the worker hands its task off while the API drains, and the API exits on it", async () => {
    expectStatus(
      await api("POST", "/api/agents", {
        agentId: AGENT_ID,
        body: { name: "drain-worker", role: "worker", status: "online" },
      }),
      [201],
      "agent registration",
    );
    expectStatus(
      await api("PUT", "/api/config", {
        body: { scope: "agent", scopeId: AGENT_ID, key: "CLAUDE_TRANSPORT", value: "sdk" },
      }),
      [200],
      "transport config",
    );
    const created = await api("POST", "/api/tasks", {
      body: {
        task: "A task the fixture never finishes.",
        routingReason: "human_pinned",
        agentId: AGENT_ID,
        source: "api",
      },
    });
    expectStatus(created, [201], "task creation");
    const taskId = String(asRecord(created.json).id);

    const home = await mkdtemp(join(fixtureDir, "home-"));
    const worker = Bun.spawn([process.execPath, "run", "src/cli.tsx", "worker", "--yolo"], {
      cwd: repoRoot,
      env: {
        ...minimalEnv(),
        PATH: `${pm2StubPath}:${process.env.PATH ?? "/usr/bin:/bin"}`,
        HOME: home,
        AGENT_SWARM_API_KEY: sut.apiKey,
        API_KEY: sut.apiKey,
        MCP_BASE_URL: sut.baseUrl,
        AGENT_ID,
        AGENT_NAME: "drain-worker",
        HARNESS_PROVIDER: "claude",
        CLAUDE_TRANSPORT: "sdk",
        CLAUDE_BINARY: fixturePath,
        CLAUDE_CODE_OAUTH_TOKEN: FIXTURE_OAUTH,
        ANTHROPIC_API_KEY: FIXTURE_API_KEY,
        CRED_CHECK_DISABLE: "1",
        CLAUDE_QUEUE_STEERING: "0",
        ANONYMIZED_TELEMETRY: "false",
        SLACK_DISABLE: "true",
        GITHUB_DISABLE: "true",
        LINEAR_DISABLE: "true",
        JIRA_DISABLE: "true",
        AGENTMAIL_DISABLE: "true",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const stdoutPromise = new Response(worker.stdout).text();
    const stderrPromise = new Response(worker.stderr).text();

    try {
      await waitForTask(taskId, (task) => task.status === "in_progress");
      // Give the runner a few ping iterations with the task in flight.
      await Bun.sleep(2_000);

      const signalledAt = Date.now();
      sut.process.kill("SIGTERM");

      // Wait on the exit, not on an HTTP read of the task. The drain closes the
      // server within one 500 ms check of the handoff, so a poll can miss the
      // short window in which the API still serves `superseded`.
      const apiExit = await Promise.race([
        sut.process.exited,
        Bun.sleep(DRAIN_CAP_MS + 5_000).then(() => "timeout" as const),
      ]);
      const exitedAfterMs = Date.now() - signalledAt;
      expect(apiExit).toBe(0);
      // On the handoff, not at the 60 s cap.
      expect(exitedAfterMs).toBeLessThan(DRAIN_CAP_MS - 10_000);

      // The drain saw the handoff before the server closed.
      await sut.drains;
      const apiLog = await Bun.file(sut.logPath).text();
      expect(apiLog).toContain("[drain] draining: waiting up to 60000ms for 1 in-flight task(s)");
      expect(apiLog).toContain("[drain] all 1 in-flight task(s) handed off");

      // The handoff is what the API left behind. Read the DB it closed.
      const db = new Database(sut.dbPath, { readonly: true });
      try {
        const row = db.query("SELECT status FROM agent_tasks WHERE id = ?").get(taskId) as {
          status: string;
        } | null;
        expect(row?.status).toBe("superseded");
      } finally {
        db.close();
      }
    } catch (error) {
      worker.kill("SIGKILL");
      const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise]);
      throw new Error(
        scrubSecrets(
          `${String(error)}\nworker stdout:\n${stdout.slice(-4000)}\nworker stderr:\n${stderr.slice(-2000)}`,
        ),
      );
    }

    // The worker outlives the API, and it handed off before any SIGTERM reached it.
    expect(worker.exitCode).toBeNull();
    worker.kill("SIGTERM");
    await Promise.race([worker.exited, Bun.sleep(15_000)]);
    if (worker.exitCode === null) worker.kill("SIGKILL");
    await worker.exited.catch(() => {});
    const [stdout] = await Promise.all([stdoutPromise, stderrPromise]);
    await rm(home, { recursive: true, force: true });

    expect(stdout).toContain("API is draining: handing off in-flight tasks, taking no new work");
    expect(stdout).toContain(`Handed off task ${taskId.slice(0, 8)} ahead of the API stopping`);
    expect(stdout).not.toContain(`Superseding task ${taskId.slice(0, 8)}`);
  }, 150_000);
});
