/**
 * Boots a full swarm stack (API + one worker) in E2B sandboxes for a single
 * eval attempt, reusing the repo's battle-tested dispatch primitives.
 *
 * Topology mirrors `e2b start-stack`: one sandbox per service, the worker
 * reaches the API over its public E2B port proxy URL. No lead — eval tasks are
 * directly assigned to the worker's agentId, which any worker handles alone.
 */
import {
  createSandbox,
  type E2BSandboxInfo,
  killSandbox,
  listSandboxes,
  sandboxPortUrl,
  startDetachedProcess,
  waitForAgentRegistration,
  waitForHttpOk,
} from "../../../src/e2b/dispatch";
import { redactWithEnv } from "../../../src/e2b/env";
import type { HarnessConfig } from "../types.ts";

const API_PORT = 3013;
const API_TEMPLATE = process.env.EVALS_E2B_TEMPLATE_API ?? "agent-swarm-api-latest";
const WORKER_TEMPLATE = process.env.EVALS_E2B_TEMPLATE_WORKER ?? "agent-swarm-worker-latest";

export interface StackHandle {
  apiSandbox: E2BSandboxInfo;
  workerSandbox: E2BSandboxInfo;
  apiUrl: string;
  swarmKey: string;
  workerAgentId: string;
  /** Redact sandbox/env secrets from text before persisting it. */
  redact: (text: string) => string;
  /** Idempotent teardown of both sandboxes. */
  kill: () => Promise<void>;
}

function e2bControllerKey(): string {
  const key = process.env.E2B_API_KEY;
  if (!key) throw new Error("E2B_API_KEY is required (seed evals/.env from the repo root .env)");
  return key;
}

function e2bApiBase(): string | undefined {
  return process.env.E2B_API_URL || undefined;
}

/**
 * Provider credentials forwarded into the worker sandbox. Only the keys the
 * configured harness actually needs — notably, never leak CLAUDE_CODE_OAUTH_TOKEN
 * into pi/opencode workers (claude creds present in env win over the configured
 * provider).
 */
export function credentialsForConfig(config: HarnessConfig): Record<string, string> {
  const out: Record<string, string> = {};
  const need = (key: string) => {
    const value = process.env[key];
    if (!value) {
      throw new Error(
        `config "${config.id}" (${config.provider}) requires ${key} in the environment`,
      );
    }
    out[key] = value;
  };
  switch (config.provider) {
    case "claude": {
      if (process.env.CLAUDE_CODE_OAUTH_TOKEN)
        out.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      else need("ANTHROPIC_API_KEY");
      break;
    }
    case "codex": {
      need("OPENAI_API_KEY");
      break;
    }
    case "pi":
    case "opencode": {
      // Credential gate is MODEL_OVERRIDE-prefix-aware: forward the key matching
      // the model's provider prefix.
      const prefix = config.model?.split("/")[0];
      if (prefix === "anthropic") need("ANTHROPIC_API_KEY");
      else if (prefix === "openai") need("OPENAI_API_KEY");
      else need("OPENROUTER_API_KEY"); // openrouter/... or unset model
      break;
    }
  }
  return out;
}

function apiRuntimeEnv(swarmKey: string): Record<string, string> {
  return {
    API_KEY: swarmKey,
    AGENT_SWARM_API_KEY: swarmKey,
    PORT: String(API_PORT),
    DATABASE_PATH: "/app/data/agent-swarm-db.sqlite",
    MIGRATIONS_DIR: "/app/migrations",
    SQLITE_VEC_EXTENSION_PATH: "/app/extensions/vec0.so",
    SCRIPT_RUNTIME_DIR: "/app/scripts-runtime",
    TS_LIB_DIR: "/app/typescript-lib",
    SCRIPT_TYPES_DIR: "/app/script-types",
    SLACK_DISABLE: "true",
    GITHUB_DISABLE: "true",
    GITLAB_DISABLE: "true",
    JIRA_DISABLE: "true",
    LINEAR_DISABLE: "true",
    AGENTMAIL_DISABLE: "true",
  };
}

function workerRuntimeEnv(opts: {
  swarmKey: string;
  apiUrl: string;
  agentId: string;
  config: HarnessConfig;
}): Record<string, string> {
  const { config } = opts;
  return {
    API_KEY: opts.swarmKey,
    AGENT_SWARM_API_KEY: opts.swarmKey,
    MCP_BASE_URL: opts.apiUrl,
    AGENT_ROLE: "worker",
    AGENT_ID: opts.agentId,
    HARNESS_PROVIDER: config.provider,
    ...(config.model ? { MODEL_OVERRIDE: config.model } : {}),
    YOLO: "true",
    MAX_CONCURRENT_TASKS: "1",
    WORKER_LOG_DIR: "/logs",
    LEAD_LOG_DIR: "/logs",
    // Image runtime defaults the dispatcher normally pins (commands.run env
    // replaces the image env, so these must be re-supplied).
    HOME: "/home/worker",
    BUN_INSTALL: "/home/worker/.bun",
    COREPACK_HOME: "/home/worker/.corepack",
    PLAYWRIGHT_BROWSERS_PATH: "/opt/playwright",
    PI_PACKAGE_DIR: "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
    CODEX_PATH_OVERRIDE: "/usr/bin/codex",
    PATH: [
      "/home/worker/.local/bin",
      "/home/worker/.opencode/bin",
      "/home/worker/.bun/bin",
      "/usr/local/sbin",
      "/usr/local/bin",
      "/usr/sbin",
      "/usr/bin",
      "/sbin",
      "/bin",
    ].join(":"),
    ...credentialsForConfig(config),
    ...(config.env ?? {}),
  };
}

/** Poll the swarm API until the worker agent reports idle + credentials ready. */
async function waitForAgentReady(opts: {
  apiUrl: string;
  swarmKey: string;
  agentId: string;
  timeoutMs: number;
}): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${opts.apiUrl}/api/agents/${opts.agentId}`, {
        headers: { Authorization: `Bearer ${opts.swarmKey}` },
      });
      if (res.ok) {
        const body = (await res.json()) as { agent?: Record<string, unknown> } & Record<
          string,
          unknown
        >;
        const agent = (body.agent ?? body) as Record<string, unknown>;
        const status = String(agent.status ?? "");
        const credStatus = agent.credStatus as { ready?: boolean } | undefined;
        last = `status=${status} credReady=${credStatus?.ready}`;
        if (status === "waiting_for_credentials") {
          throw new Error(
            `worker parked in waiting_for_credentials (missing/incorrect provider creds for this config): ${JSON.stringify(credStatus)}`,
          );
        }
        if (status === "idle" && credStatus?.ready !== false) return;
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes("waiting_for_credentials")) throw err;
      last = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(2_000);
  }
  throw new Error(`worker agent never became ready within ${opts.timeoutMs}ms (last: ${last})`);
}

export async function bootStack(opts: {
  config: HarnessConfig;
  /** Groups both sandboxes in e2b listings, e.g. "evals-<runId>". */
  swarmSlug: string;
  /** Sandbox TTL. Default 1800s. */
  timeoutSec?: number;
  /** Per-service readiness wait. Default 120s API / 180s worker. */
  waitMs?: number;
  log?: (msg: string) => void;
}): Promise<StackHandle> {
  const e2bKey = e2bControllerKey();
  const apiBase = e2bApiBase();
  const timeoutSec = opts.timeoutSec ?? 1800;
  const log = opts.log ?? (() => {});
  const swarmKey = `evals-${crypto.randomUUID()}`;
  const workerAgentId = crypto.randomUUID();

  const created: E2BSandboxInfo[] = [];
  let killed = false;
  const kill = async () => {
    if (killed) return;
    killed = true;
    for (const sandbox of created) {
      try {
        await killSandbox(sandbox.sandboxID, e2bKey, apiBase);
      } catch (err) {
        log(
          `warn: failed to kill sandbox ${sandbox.sandboxID}: ${err instanceof Error ? err.message : err}`,
        );
      }
    }
  };

  try {
    log(`creating API sandbox (template ${API_TEMPLATE})`);
    const apiEnv = apiRuntimeEnv(swarmKey);
    const apiSandbox = await createSandbox({
      apiKey: e2bKey,
      apiBase,
      template: API_TEMPLATE,
      timeoutSec,
      envVars: apiEnv,
      metadata: {
        app: "agent-swarm",
        launcher: "agent-swarm-e2b",
        role: "api",
        swarm: opts.swarmSlug,
        swarmRole: "api",
        apiPort: String(API_PORT),
        evals: "true",
      },
    });
    created.push(apiSandbox);
    await startDetachedProcess({
      sandbox: apiSandbox,
      apiKey: e2bKey,
      apiBase,
      env: apiEnv,
      command: "/api-entrypoint.sh",
      role: "api",
      cwd: "/app",
    });
    const apiUrl = sandboxPortUrl(apiSandbox, API_PORT, process.env as Record<string, string>);
    log(`waiting for API health at ${apiUrl}`);
    await waitForHttpOk(`${apiUrl}/health`, opts.waitMs ?? 120_000);

    log(
      `creating worker sandbox (template ${WORKER_TEMPLATE}, ${opts.config.provider}${opts.config.model ? ` / ${opts.config.model}` : ""})`,
    );
    const workerEnv = workerRuntimeEnv({
      swarmKey,
      apiUrl,
      agentId: workerAgentId,
      config: opts.config,
    });
    const workerSandbox = await createSandbox({
      apiKey: e2bKey,
      apiBase,
      template: WORKER_TEMPLATE,
      timeoutSec,
      envVars: workerEnv,
      metadata: {
        app: "agent-swarm",
        launcher: "agent-swarm-e2b",
        role: "worker",
        swarm: opts.swarmSlug,
        swarmRole: "worker",
        agentId: workerAgentId,
        evals: "true",
      },
    });
    created.push(workerSandbox);
    await startDetachedProcess({
      sandbox: workerSandbox,
      apiKey: e2bKey,
      apiBase,
      env: workerEnv,
      command: "/docker-entrypoint.sh",
      role: "worker",
      cwd: "/workspace",
    });
    log("waiting for worker agent registration");
    await waitForAgentRegistration(apiUrl, workerAgentId, swarmKey, opts.waitMs ?? 180_000);
    log("waiting for worker to be idle + credentials ready");
    await waitForAgentReady({ apiUrl, swarmKey, agentId: workerAgentId, timeoutMs: 120_000 });

    const secretEnv = { ...workerEnv, ...apiEnv, E2B_API_KEY: e2bKey };
    return {
      apiSandbox,
      workerSandbox,
      apiUrl,
      swarmKey,
      workerAgentId,
      redact: (text: string) => redactWithEnv(text, secretEnv),
      kill,
    };
  } catch (err) {
    await kill();
    throw err;
  }
}

/** Run a shell command inside a sandbox; never throws on non-zero exit. */
export async function sandboxExec(
  sandboxId: string,
  cmd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.connect(sandboxId, {
    apiKey: e2bControllerKey(),
    ...(process.env.E2B_API_URL ? { apiUrl: process.env.E2B_API_URL } : {}),
    ...(process.env.E2B_DOMAIN ? { domain: process.env.E2B_DOMAIN } : {}),
  });
  const quoted = `'${cmd.split("'").join(`'\\''`)}'`;
  try {
    const res = await sandbox.commands.run(`bash -lc ${quoted}`, {
      user: "root",
      timeoutMs: 60_000,
    });
    return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
  } catch (err) {
    const e = err as { exitCode?: number; stdout?: string; stderr?: string; message?: string };
    if (typeof e.exitCode === "number") {
      return { exitCode: e.exitCode, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message ?? "" };
    }
    throw err;
  }
}

export async function sandboxReadFile(sandboxId: string, path: string): Promise<string | null> {
  const res = await sandboxExec(sandboxId, `cat ${JSON.stringify(path)}`);
  return res.exitCode === 0 ? res.stdout : null;
}

/**
 * Kill sandboxes leaked by an interrupted execution of this run (the process
 * died before `kill()` ran). Matches on the metadata.swarm slug every eval
 * sandbox is stamped with, so it never touches non-eval sandboxes.
 */
export async function sweepRunSandboxes(
  runId: string,
  log: (msg: string) => void = () => {},
): Promise<number> {
  const e2bKey = e2bControllerKey();
  const apiBase = e2bApiBase();
  const slug = `evals-${runId}`;
  let sandboxes: E2BSandboxInfo[];
  try {
    sandboxes = await listSandboxes(e2bKey, apiBase);
  } catch (err) {
    log(`warn: could not list sandboxes for sweep: ${err instanceof Error ? err.message : err}`);
    return 0;
  }
  const leaked = sandboxes.filter((s) => s.metadata?.swarm === slug);
  for (const sandbox of leaked) {
    try {
      await killSandbox(sandbox.sandboxID, e2bKey, apiBase);
      log(`swept leaked sandbox ${sandbox.sandboxID} (${sandbox.metadata?.swarmRole ?? "?"})`);
    } catch (err) {
      log(
        `warn: failed to sweep ${sandbox.sandboxID}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }
  return leaked.length;
}

/** Where each harness writes its raw session files inside the worker sandbox. */
const HARNESS_SESSION_DIRS: Record<HarnessConfig["provider"], string[]> = {
  claude: ["/home/worker/.claude/projects"],
  codex: ["/home/worker/.codex/sessions"],
  pi: ["/home/worker/.pi"],
  opencode: ["/home/worker/.local/share/opencode"],
};

export const ATTEMPT_START_MARKER = "/tmp/eval-attempt-start";

/** Touch the marker right after boot so session-file capture only picks up this attempt's files. */
export async function markAttemptStart(sandboxId: string): Promise<void> {
  await sandboxExec(sandboxId, `touch ${ATTEMPT_START_MARKER}`);
}

const MAX_SESSION_FILES = 10;
const MAX_SESSION_FILE_BYTES = 1_500_000;

/**
 * Collect the harness's own raw session files (e.g. Claude Code's
 * ~/.claude/projects/**\/*.jsonl) written since {@link markAttemptStart}.
 * Returns newest-first, capped in count and per-file size.
 */
export async function collectHarnessSessionFiles(
  sandboxId: string,
  provider: HarnessConfig["provider"],
): Promise<{ path: string; content: string; truncated: boolean }[]> {
  const dirs = HARNESS_SESSION_DIRS[provider] ?? [];
  if (dirs.length === 0) return [];
  const find = await sandboxExec(
    sandboxId,
    `find ${dirs.map((d) => JSON.stringify(d)).join(" ")} -type f ` +
      `\\( -name '*.jsonl' -o -name '*.json' \\) -newer ${ATTEMPT_START_MARKER} ` +
      `-printf '%T@ %s %p\\n' 2>/dev/null | sort -rn | head -${MAX_SESSION_FILES}`,
  );
  if (find.exitCode !== 0 || !find.stdout.trim()) return [];

  const files: { path: string; content: string; truncated: boolean }[] = [];
  for (const line of find.stdout.trim().split("\n")) {
    const match = line.match(/^\S+ (\d+) (.+)$/);
    if (!match) continue;
    const size = Number(match[1]);
    const path = match[2] as string;
    const read = await sandboxExec(
      sandboxId,
      `head -c ${MAX_SESSION_FILE_BYTES} ${JSON.stringify(path)}`,
    );
    if (read.exitCode !== 0) continue;
    files.push({ path, content: read.stdout, truncated: size > MAX_SESSION_FILE_BYTES });
  }
  return files;
}
