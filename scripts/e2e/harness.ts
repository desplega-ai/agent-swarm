import type { ApiClient } from "./http";
import { asRecord, expect, expectStatus, pollUntil } from "./http";
import type { HarnessResult } from "./report";
import { minimalEnv, repoRoot, tailLog } from "./sut";

const DEFAULT_MODELS: Record<string, string> = {
  claude: "claude-haiku-4-5-20251001",
  codex: "gpt-5.6-luna",
  pi: "openrouter/deepseek/deepseek-v4-flash",
};
type HarnessChild = Bun.Subprocess<"ignore", "pipe", "pipe">;

const activeChildren = new Set<HarnessChild>();

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function drain(stream: ReadableStream<Uint8Array>, writer: Bun.FileSink) {
  return (async () => {
    for await (const chunk of stream) writer.write(chunk);
  })();
}

async function stopChild(child: HarnessChild): Promise<void> {
  if (child.exitCode === null) {
    child.kill("SIGTERM");
    await Promise.race([child.exited, Bun.sleep(10_000)]);
  }
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await child.exited.catch(() => {});
  }
  activeChildren.delete(child);
}

export async function stopHarnessChildren(): Promise<void> {
  await Promise.all([...activeChildren].map(stopChild));
}

function modelFor(provider: string): string {
  const key = `E2E_MODEL_${provider.toUpperCase()}`;
  return process.env[key] || DEFAULT_MODELS[provider] || "";
}

function workerEnv(
  provider: string,
  agentId: string,
  baseUrl: string,
  apiKey: string,
  model: string,
  homeDir: string,
) {
  const env: Record<string, string> = {
    ...minimalEnv(),
    HOME: homeDir,
    LOG_DIR: `${homeDir}/logs`,
    AGENT_ID: agentId,
    MCP_BASE_URL: baseUrl,
    API_KEY: apiKey,
    AGENT_SWARM_API_KEY: apiKey,
    HARNESS_PROVIDER: provider,
    AGENT_ROLE: "worker",
    YOLO: "true",
    MODEL_OVERRIDE: model,
    MAX_CONCURRENT_TASKS: "1",
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    CONTEXT_MODE_DISABLED: "true",
    DISABLE_AUTOUPDATER: "1",
    STARTUP_SCRIPT_STRICT: "false",
  };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "OPENAI_API_KEY",
    "OPENROUTER_API_KEY",
    "OPENROUTER_BASE_URL",
    "PI_PACKAGE_DIR",
    "CODEX_PATH_OVERRIDE",
  ]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }
  return env;
}

function requireCredential(provider: string): void {
  if (provider === "claude") {
    expect(
      process.env.CLAUDE_CODE_OAUTH_TOKEN || process.env.ANTHROPIC_API_KEY,
      "Claude requires CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY",
    );
  } else if (provider === "codex") {
    expect(process.env.OPENAI_API_KEY, "Codex requires OPENAI_API_KEY");
  } else if (provider === "pi") {
    expect(
      process.env.OPENROUTER_API_KEY || process.env.ANTHROPIC_API_KEY,
      "Pi requires OPENROUTER_API_KEY or ANTHROPIC_API_KEY",
    );
  }
}

async function prepareHarnessHome(homeDir: string, provider: string): Promise<void> {
  const claudeDir = `${homeDir}/.claude/commands`;
  const piDir = `${homeDir}/.pi/agent/skills/work-on-task`;
  const codexDir = `${homeDir}/.codex/skills/work-on-task`;
  await Bun.$`mkdir -p ${homeDir}/logs ${claudeDir} ${piDir} ${codexDir}`.quiet();
  const command = await Bun.file(`${repoRoot}/plugin/commands/work-on-task.md`).text();
  const piSkill = await Bun.file(`${repoRoot}/plugin/pi-skills/work-on-task/SKILL.md`).text();
  await Promise.all([
    Bun.write(`${claudeDir}/work-on-task.md`, command),
    Bun.write(`${piDir}/SKILL.md`, piSkill),
    Bun.write(`${codexDir}/SKILL.md`, command),
  ]);
  if (provider === "codex" && process.env.OPENAI_API_KEY) {
    const login = Bun.spawn(["codex", "login", "--with-api-key"], {
      env: { ...minimalEnv(), HOME: homeDir },
      stdin: "pipe",
      stdout: "ignore",
      stderr: "pipe",
    });
    login.stdin.write(process.env.OPENAI_API_KEY);
    login.stdin.end();
    const stderr = await new Response(login.stderr).text();
    const exitCode = await login.exited;
    expect(exitCode === 0, `codex login failed: ${stderr.slice(0, 300)}`);
  }
  if (process.getuid?.() === 0 && Bun.which("gosu")) {
    await Bun.$`chown -R worker:worker ${homeDir}`.quiet();
  }
}

function workerCommand(): string[] {
  const command = ["bun", "run", "src/cli.tsx", "worker", "--yolo"];
  return process.getuid?.() === 0 && Bun.which("gosu") ? ["gosu", "worker", ...command] : command;
}

// The worker's own HTTP and MCP traffic bypasses the client recorder. It does not count toward MVP coverage.
export async function runHarnessLeg(
  provider: string,
  api: ApiClient,
  baseUrl: string,
  apiKey: string,
  nonce: string,
): Promise<HarnessResult> {
  const started = Date.now();
  const model = modelFor(provider);
  const stamp = `${Date.now()}-${provider}`;
  const logPath = `/tmp/e2e-harness-${provider}-${stamp}.log`;
  const homeDir = `/tmp/e2e-harness-home-${stamp}`;
  let child: HarnessChild | undefined;
  let writer: Bun.FileSink | undefined;
  let drains: Promise<unknown> | undefined;
  try {
    expect(
      ["claude", "codex", "pi"].includes(provider),
      `Unsupported harness provider: ${provider}`,
    );
    requireCredential(provider);
    await prepareHarnessHome(homeDir, provider);
    const register = await api("POST", "/api/agents", {
      body: {
        name: `e2e-harness-${provider}-${nonce}`,
        role: "worker",
        status: "online",
        harness_provider: provider,
      },
    });
    expectStatus(register, [201], `register ${provider} harness agent`);
    const agentId = asRecord(register.json).id;
    expect(typeof agentId === "string", `${provider} registration response has no id`);
    const marker = `PONG-${nonce}`;
    const create = await api("POST", "/api/tasks", {
      body: {
        task: `Reply with exactly the text ${marker} and nothing else. Do not use any tools.`,
        agentId,
        source: "api",
      },
    });
    expectStatus(create, [201], `create ${provider} harness task`);
    const taskId = asRecord(create.json).id;
    expect(typeof taskId === "string", `${provider} task response has no id`);

    writer = Bun.file(logPath).writer();
    child = Bun.spawn(workerCommand(), {
      cwd: repoRoot,
      env: workerEnv(provider, agentId, baseUrl, apiKey, model, homeDir),
      stdout: "pipe",
      stderr: "pipe",
    });
    activeChildren.add(child);
    drains = Promise.all([drain(child.stdout, writer), drain(child.stderr, writer)]);

    let task: Record<string, unknown> | undefined;
    const timeoutMs = Number(process.env.E2E_HARNESS_TIMEOUT_MS || 300_000);
    const terminal = await pollUntil(
      async () => {
        const response = await api("GET", `/api/tasks/${taskId}`);
        expectStatus(response, [200], `poll ${provider} task`);
        task = asRecord(response.json);
        return task.status === "completed" || task.status === "failed";
      },
      timeoutMs,
      1_000,
    );
    expect(terminal && task, `${provider} task did not finish within ${timeoutMs}ms`);
    expect(
      task.status === "completed",
      `${provider} task finished with status ${String(task.status)}`,
    );
    const resultText = `${String(task.output ?? "")}\n${String(task.progress ?? "")}`.toLowerCase();
    expect(
      resultText.includes(marker.toLowerCase()),
      `${provider} task output does not contain ${marker}`,
    );
    expect(
      typeof task.claudeSessionId === "string" && task.claudeSessionId.length > 0,
      `${provider} task has no session id`,
    );

    const costs = await api("GET", `/api/session-costs?agentId=${agentId}`);
    if (costs.status === 200) {
      const entries = asRecord(costs.json).costs;
      console.log(
        `INFO harness ${provider} cost records: ${Array.isArray(entries) ? entries.length : 0}`,
      );
    }
    return { provider, model, status: "pass", durationMs: Date.now() - started };
  } catch (error) {
    writer?.flush();
    const tail = await tailLog(logPath, 60);
    if (tail) console.error(`Last 60 lines of ${logPath}:\n${tail}`);
    return {
      provider,
      model,
      status: "fail",
      durationMs: Date.now() - started,
      error: errorMessage(error),
    };
  } finally {
    if (child) await stopChild(child);
    await drains?.catch(() => {});
    writer?.end();
    await Bun.$`rm -rf ${homeDir}`.quiet().catch(() => {});
  }
}
