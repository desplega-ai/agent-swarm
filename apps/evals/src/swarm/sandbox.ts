/**
 * Boots a full swarm stack (API + the scenario's roster members) in E2B
 * sandboxes for a single eval attempt, reusing the repo's battle-tested
 * dispatch primitives.
 *
 * Topology mirrors `e2b start-stack`: one sandbox per service, members reach
 * the API over its public E2B port proxy URL. Rosters may be heterogeneous
 * (v7 §9/§12): each member boots with its own EFFECTIVE HarnessConfig (cell
 * config unless overridden) and identity envs (TEMPLATE_ID / AGENT_NAME /
 * SYSTEM_PROMPT; defaults per v7.5 item 7 — lead → official/lead + "Lead",
 * workers → AGENT_NAME `Worker <i>` only), and a scenario may add ONE lead
 * member (AGENT_ROLE=lead —
 * the swarm routes agentId-less tasks to it). Eval tasks are otherwise
 * directly assigned to a worker's agentId.
 */
import {
  createSandbox,
  type E2BSandboxInfo,
  e2bSdkConnectionOptions,
  killSandbox,
  listSandboxes,
  sandboxPortUrl,
  startDetachedProcess,
  waitForAgentRegistration,
  waitForHttpOk,
} from "../../../../src/e2b/dispatch";
import { redactWithEnv } from "../../../../src/e2b/env";
import { defaultMemberIdentity, type HarnessConfig, type WorkerSpec } from "../types.ts";
import { cleanVersion } from "./version.ts";

const API_PORT = 3013;
const API_TEMPLATE = process.env.EVALS_E2B_TEMPLATE_API ?? "agent-swarm-api-latest";
const WORKER_TEMPLATE = process.env.EVALS_E2B_TEMPLATE_WORKER ?? "agent-swarm-worker-latest";

/** stdout/stderr clip for the SQL-seed import result (matches the runner's SEED_OUTPUT_CLIP). */
const SQL_SEED_OUTPUT_CLIP = 20_000;

/**
 * Wrap a string as a single POSIX shell single-quoted argument, escaping any
 * embedded single quotes (`'` → `'\''`). Used to pass the pre-boot migrate+seed
 * `bun -e` script body to `sandboxExec` without shell-injection or quoting bugs.
 */
function shSingleQuote(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/**
 * One resolved roster member to boot (v7 §9.3 — FROZEN shape). The runner
 * resolves these from the scenario's `workers` / `lead` against the matrix
 * cell's config (frozen §12.3 rule) and passes them to {@link bootStack}.
 */
export interface BootMember {
  /** 0..N-1 workers; the lead (when present) is index N (v7 §12.4). */
  index: number;
  role: "lead" | "worker";
  /** `{}` for default members (numeric `workers` shape). */
  spec: WorkerSpec;
  /** EFFECTIVE config (v7 §12.3) — the cell config unless the spec overrode it. */
  config: HarnessConfig;
  /** True iff spec.configId or spec.model overrode the cell config. */
  overridden: boolean;
}

export interface WorkerHandle {
  /** 0-based member index, stable for the attempt's lifetime (lead = N). */
  index: number;
  /** The boot member this handle was created from (role/spec/effective config). */
  member: BootMember;
  sandbox: E2BSandboxInfo;
  /** UUID generated host-side; the worker self-registers under it via AGENT_ID env. */
  agentId: string;
  /** `agent-swarm version` output inside this worker's sandbox; null = capture failed. */
  version: string | null;
}

export interface SqlSeedResult {
  fixture: string; // bare filename, e.g. "delegation-probe-history.sql"
  exitCode: number; // always 0 on a returned StackHandle (non-zero throws in boot)
  durationMs: number;
  stdout: string;
  stderr: string;
}

export interface StackHandle {
  apiSandbox: E2BSandboxInfo;
  /**
   * One handle per booted member, ordered by index: workers 0..N-1, then the
   * lead at index N when the scenario defines one (v7 §12.4).
   */
  workers: WorkerHandle[];
  apiUrl: string;
  swarmKey: string;
  /** Swarm API version from the sandbox /health response. Null if capture failed. */
  apiVersion: string | null;
  /** Non-null when the scenario seeded the API DB via seed.sqlDump (v6 §1). */
  sqlSeed: SqlSeedResult | null;
  /** Redact sandbox/env secrets from text before persisting it. */
  redact: (text: string) => string;
  /** Idempotent teardown of the API + ALL worker sandboxes. */
  kill: () => Promise<void>;
}

/**
 * Pipe each output line through a pure-bash ISO-8601 UTC timestamper (v6 §4).
 * - stdbuf -oL -eL line-buffers the producer (both images ship coreutils).
 * - printf '%(...)T' is a bash builtin (no per-line fork); second precision.
 * - `|| [ -n "$line" ]` flushes a trailing unterminated line at EOF.
 * - Composes with buildTrackedShell's pipefail: the entrypoint's non-zero exit
 *   still propagates through the pipeline, so startDetachedProcess's 2s
 *   liveness poll and launch-failure detection keep working.
 *
 * Resulting log-line shape (FROZEN, consumed by the UI's timestamp parser):
 * `2026-06-11T21:30:05Z <original line>`.
 */
export function withLineTimestamps(cmd: string): string {
  return (
    `stdbuf -oL -eL ${cmd} 2>&1 | ` +
    `while IFS= read -r line || [ -n "$line" ]; do ` +
    `TZ=UTC printf '%(%Y-%m-%dT%H:%M:%SZ)T %s\\n' -1 "$line"; ` +
    `done`
  );
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

/** Exported for tests. */
export function apiRuntimeEnv(swarmKey: string): Record<string, string> {
  return {
    API_KEY: swarmKey,
    AGENT_SWARM_API_KEY: swarmKey,
    PORT: String(API_PORT),
    NODE_ENV: "production",
    DESPLEGA_TELEMETRY_ENV: "test",
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
    // Server-side memory embeddings — EMBEDDING_*-differentiated (v7.6 §A2).
    // The API resolves EMBEDDING_API_KEY ?? OPENAI_API_KEY (src/be/memory/
    // providers/openai-embedding.ts); we pass EMBEDDING_* explicitly and no
    // longer forward OPENAI_API_KEY as the embedding fallback (evals/.env sets
    // EMBEDDING_API_KEY). Without a key, POST /api/memory/search silently
    // returns {results: []} — but memory-seeded attempts still fail loudly at
    // the runner's seed-searchability gate. API sandbox ONLY — worker provider
    // creds stay strictly gated by credentialsForConfig. The former
    // EMBEDDING_DIMENSIONS="512" pin (≤1.85-template NaN workaround) is gone:
    // 1.97.0 templates default the dimension server-side.
    ...(process.env.EMBEDDING_API_KEY ? { EMBEDDING_API_KEY: process.env.EMBEDDING_API_KEY } : {}),
    ...(process.env.EMBEDDING_MODEL ? { EMBEDDING_MODEL: process.env.EMBEDDING_MODEL } : {}),
    ...(process.env.EMBEDDING_API_BASE_URL
      ? { EMBEDDING_API_BASE_URL: process.env.EMBEDDING_API_BASE_URL }
      : {}),
  };
}

/**
 * Per-member sandbox env (exported for tests). Built from the member's
 * EFFECTIVE config; frozen merge order (v7 §9.3, later wins):
 *   1. base runtime env (AGENT_ROLE = member role; MAX_CONCURRENT_TASKS "1"
 *      for workers / "2" for the lead — the worker entrypoint's lead default);
 *   2. credentialsForConfig(effectiveConfig) — per-member credential isolation;
 *   3. effectiveConfig.env ?? {};
 *   4. identity envs via defaultMemberIdentity(role, index, spec) (v7.5
 *      item 7): TEMPLATE_ID (spec.template, defaulting to official/lead for
 *      the LEAD only — plain workers get NO template default because a
 *      template rewrites the eval subject's system prompt), AGENT_NAME
 *      (spec.name ?? "Lead" / `Worker <index>`, always emitted so agents stop
 *      registering as the entrypoint's `worker-<hash>` fallback), and
 *      SYSTEM_PROMPT (spec.systemPrompt, unchanged);
 *   5. spec.env ?? {} (validated non-reserved at registry load).
 *   6. DESPLEGA_TELEMETRY_ENV="test" (eval traffic must never enter the
 *      production telemetry cohort).
 */
export function workerRuntimeEnv(opts: {
  swarmKey: string;
  apiUrl: string;
  agentId: string;
  /** EFFECTIVE member config (v7 §12.3). */
  config: HarnessConfig;
  /** Member role; default "worker". */
  role?: "lead" | "worker";
  /** 0-based member index (v7.5 item 7 — names the default `Worker <index>`); default 0. */
  index?: number;
  /** Member identity + extra env (v7 §9); default {}. */
  spec?: WorkerSpec;
}): Record<string, string> {
  const { config } = opts;
  const role = opts.role ?? "worker";
  const spec = opts.spec ?? {};
  const identity = defaultMemberIdentity(role, opts.index ?? 0, spec);
  return {
    API_KEY: opts.swarmKey,
    AGENT_SWARM_API_KEY: opts.swarmKey,
    MCP_BASE_URL: opts.apiUrl,
    AGENT_ROLE: role,
    AGENT_ID: opts.agentId,
    HARNESS_PROVIDER: config.provider,
    ...(config.model ? { MODEL_OVERRIDE: config.model } : {}),
    YOLO: "true",
    MAX_CONCURRENT_TASKS: role === "lead" ? "2" : "1",
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
    // Identity envs (v7 §9.3 step 4, defaults per v7.5 item 7) — these keys
    // are in WORKER_SPEC_RESERVED_ENV, so spec.env can never collide.
    // AGENT_NAME is always emitted (deterministic even when the entrypoint's
    // template fetch fails — that fetch is non-fatal, warn+continue);
    // TEMPLATE_ID only when the spec set one or the member is the lead.
    ...(identity.templateId ? { TEMPLATE_ID: identity.templateId } : {}),
    AGENT_NAME: identity.agentName,
    ...(spec.systemPrompt ? { SYSTEM_PROMPT: spec.systemPrompt } : {}),
    ...(spec.env ?? {}),
    DESPLEGA_TELEMETRY_ENV: "test",
  };
}

/** Poll the swarm API until the worker agent reports idle + credentials ready. */
async function waitForAgentReady(opts: {
  apiUrl: string;
  swarmKey: string;
  agentId: string;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<void> {
  const deadline = Date.now() + opts.timeoutMs;
  let last = "";
  while (Date.now() < deadline) {
    opts.signal?.throwIfAborted();
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
  /**
   * Resolved roster members to boot (v7 §9.3) — workers at indices 0..N-1,
   * optionally followed by ONE lead at index N. The runner resolves these
   * from the scenario; count semantics are unchanged from the v1 number form.
   */
  members: BootMember[];
  /** Groups every sandbox of the attempt in e2b listings, e.g. "evals-<runId>". */
  swarmSlug: string;
  /** SQL text dump imported into /app/data/agent-swarm-db.sqlite BEFORE the API entrypoint starts. */
  preBootSql?: { fixture: string; text: string };
  /** Sandbox TTL. Default 1800s. */
  timeoutSec?: number;
  /** Per-service readiness wait. Default 120s API / 180s worker. */
  waitMs?: number;
  /**
   * Cancel signal. Checked before/after each boot step; on abort the catch
   * below kills every sandbox created so far, so a cancel during boot never
   * leaks a stack (the runner only tracks stacks for kill AFTER boot returns).
   */
  signal?: AbortSignal;
  log?: (msg: string) => void;
}): Promise<StackHandle> {
  const e2bKey = e2bControllerKey();
  const apiBase = e2bApiBase();
  const timeoutSec = opts.timeoutSec ?? 1800;
  const log = opts.log ?? (() => {});
  const swarmKey = `evals-${crypto.randomUUID()}`;
  const members = opts.members;
  // One agent id per member — a shared AGENT_ID would collapse N members into
  // one agent row (the entrypoint self-registers via X-Agent-ID: $AGENT_ID).
  const memberAgentIds = members.map(() => crypto.randomUUID());

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
    opts.signal?.throwIfAborted();
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
    opts.signal?.throwIfAborted();

    // INSERT-only seeding: import BEFORE the API entrypoint starts, so the
    // server's first boot sees a fully-migrated DB + the seeded rows, and
    // boot-time caches pick them up. envd is independent of the entrypoint, so
    // exec/file APIs work pre-boot.
    //
    // The fixture is INSERT-only (the seed rows, no schema, no `_migrations`).
    // We build the schema PRE-BOOT by applying the REAL migration `.sql` files
    // that ship in the image (`MIGRATIONS_DIR`, default /app/migrations —
    // Dockerfile COPYs them there) in the SAME way `src/be/migrations/runner.ts`
    // does, then write the matching `_migrations` bookkeeping (version, name,
    // applied_at, checksum). The post-boot runner then finds `_migrations` fully
    // populated and applies ZERO further migrations (and warns on no checksum
    // mismatch). This kills the schema-drift footgun of the old full-dump
    // fixtures: the schema is ALWAYS the real migrations.
    let sqlSeed: SqlSeedResult | null = null;
    if (opts.preBootSql) {
      const { fixture, text } = opts.preBootSql;
      log(`migrate+seed ${fixture} (${Buffer.byteLength(text, "utf8")} bytes)`);
      // Upload via the E2B files API (avoids shell-quoting the seed body).
      await sandboxWriteFile(apiSandbox.sandboxID, "/tmp/eval-seed.sql", text);
      // Mirror of runMigrations() in src/be/migrations/runner.ts — kept in lockstep
      // (filename sort, version = parseInt(prefix), name = file minus .sql,
      // checksum = sha256(content), each in its own transaction, FKs off for the
      // pass) so the bookkeeping matches byte-for-byte and the post-boot runner
      // re-applies nothing. Migrations build the schema; then the INSERT-only seed
      // lands on top. Any failure here = boot failure (caught below).
      const migrateAndSeed = [
        'const { Database } = require("bun:sqlite");',
        'const { createHash } = require("crypto");',
        'const { readdirSync, readFileSync } = require("fs");',
        'const { join } = require("path");',
        'const migrationsDir = process.env.MIGRATIONS_DIR || "/app/migrations";',
        'const db = new Database("/app/data/agent-swarm-db.sqlite");',
        'db.run("CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)");',
        'const files = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();',
        'if (files.length === 0) throw new Error("no migration .sql files in " + migrationsDir);',
        'db.run("PRAGMA foreign_keys = OFF");',
        "for (const file of files) {",
        '  const version = parseInt(file.split("_")[0] || "0", 10);',
        '  const name = file.replace(".sql", "");',
        '  const sql = readFileSync(join(migrationsDir, file), "utf-8");',
        '  const checksum = createHash("sha256").update(sql).digest("hex");',
        "  db.transaction(() => {",
        "    db.exec(sql);",
        '    db.run("INSERT INTO _migrations (version, name, applied_at, checksum) VALUES (?, ?, ?, ?)", [version, name, new Date().toISOString(), checksum]);',
        "  })();",
        "}",
        'db.run("PRAGMA foreign_keys = ON");',
        'db.exec(readFileSync("/tmp/eval-seed.sql", "utf8"));',
        "db.close();",
      ].join("");
      const importCmd = `mkdir -p /app/data && bun -e ${shSingleQuote(migrateAndSeed)} && rm -f /tmp/eval-seed.sql`;
      const t0 = Date.now();
      const res = await sandboxExec(apiSandbox.sandboxID, importCmd);
      const durationMs = Date.now() - t0;
      if (res.exitCode !== 0) {
        // Failure = boot failure: the catch below kills all created sandboxes.
        const detail = redactWithEnv(`${res.stderr}\n${res.stdout}`.trim(), {
          ...apiEnv,
          E2B_API_KEY: e2bKey,
        }).slice(0, 2000);
        throw new Error(
          `sql-seed import failed (exit ${res.exitCode}) for fixture ${fixture}: ${detail}`,
        );
      }
      sqlSeed = {
        fixture,
        exitCode: 0,
        durationMs,
        stdout: res.stdout.slice(0, SQL_SEED_OUTPUT_CLIP),
        stderr: res.stderr.slice(0, SQL_SEED_OUTPUT_CLIP),
      };
      log(`SQL seed imported in ${durationMs}ms`);
    }
    opts.signal?.throwIfAborted();

    await startDetachedProcess({
      sandbox: apiSandbox,
      apiKey: e2bKey,
      apiBase,
      env: apiEnv,
      command: withLineTimestamps("/api-entrypoint.sh"),
      role: "api",
      cwd: "/app",
    });
    const apiUrl = sandboxPortUrl(apiSandbox, API_PORT, process.env as Record<string, string>);
    log(`waiting for API health at ${apiUrl}`);
    opts.signal?.throwIfAborted();
    await waitForHttpOk(`${apiUrl}/health`, opts.waitMs ?? 120_000);
    // Captured during boot so it lands in the boot-time sandboxJson write.
    // /health responds { status, version } (src/http/core.ts). Non-fatal → null.
    let apiVersion: string | null = null;
    try {
      const health = (await (await fetch(`${apiUrl}/health`)).json()) as { version?: unknown };
      if (typeof health.version === "string") apiVersion = health.version;
    } catch {
      // best-effort version capture
    }
    opts.signal?.throwIfAborted();

    // Boot all members in parallel — sequential boots add ~1–3 min each
    // (registration + idle waits). Promise.all rejects on the first failure;
    // the catch below kills everything created so far (sandboxes are pushed
    // into `created` synchronously right after creation).
    const allWorkerEnvs: Record<string, string>[] = [];
    const bootMember = async (member: BootMember, position: number): Promise<WorkerHandle> => {
      const agentId = memberAgentIds[position] as string;
      const config = member.config;
      log(
        `creating ${member.role} ${member.index} sandbox (template ${WORKER_TEMPLATE}, ` +
          `${config.provider}${config.model ? ` / ${config.model}` : ""}` +
          `${member.overridden ? " [override]" : ""})`,
      );
      const workerEnv = workerRuntimeEnv({
        swarmKey,
        apiUrl,
        agentId,
        config,
        role: member.role,
        index: member.index,
        spec: member.spec,
      });
      allWorkerEnvs.push(workerEnv);
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
          // "lead" for the lead member — matches the root e2b.ts convention.
          swarmRole: member.role,
          workerIndex: String(member.index),
          agentId,
          evals: "true",
        },
      });
      created.push(workerSandbox);
      opts.signal?.throwIfAborted();
      await startDetachedProcess({
        sandbox: workerSandbox,
        apiKey: e2bKey,
        apiBase,
        env: workerEnv,
        command: withLineTimestamps("/docker-entrypoint.sh"),
        role: "worker",
        cwd: "/workspace",
      });
      log(`waiting for ${member.role} ${member.index} agent registration`);
      opts.signal?.throwIfAborted();
      await waitForAgentRegistration(apiUrl, agentId, swarmKey, opts.waitMs ?? 180_000);
      log(`waiting for ${member.role} ${member.index} to be idle + credentials ready`);
      opts.signal?.throwIfAborted();
      await waitForAgentReady({
        apiUrl,
        swarmKey,
        agentId,
        timeoutMs: 120_000,
        signal: opts.signal,
      });
      opts.signal?.throwIfAborted();

      // Worker build version via the compiled CLI (prints "agent-swarm vX.Y.Z";
      // there is no -V flag — `version` is the subcommand). The CLI restores the
      // cursor on exit (ESC[?25h) — cleanVersion strips ANSI/control sequences
      // before extracting, so we store a clean "1.85.0" (v5 spec §5).
      // Non-fatal → null.
      let version: string | null = null;
      try {
        const res = await sandboxExec(workerSandbox.sandboxID, "agent-swarm version");
        if (res.exitCode === 0) version = cleanVersion(res.stdout);
      } catch {
        // best-effort version capture
      }
      return { index: member.index, member, sandbox: workerSandbox, agentId, version };
    };
    const workers = await Promise.all(members.map((m, i) => bootMember(m, i)));
    opts.signal?.throwIfAborted();

    // Every worker's env joins the secret set — any of them can leak into logs.
    const secretEnv = Object.assign({}, ...allWorkerEnvs, apiEnv, { E2B_API_KEY: e2bKey });
    return {
      apiSandbox,
      workers,
      apiUrl,
      swarmKey,
      apiVersion,
      sqlSeed,
      redact: (text: string) => redactWithEnv(text, secretEnv),
      kill,
    };
  } catch (err) {
    await kill();
    throw err;
  }
}

/** Write a file into a sandbox via the E2B files API (no shell quoting limits). */
async function sandboxWriteFile(sandboxId: string, path: string, content: string): Promise<void> {
  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.connect(
    sandboxId,
    e2bSdkConnectionOptions(
      e2bControllerKey(),
      process.env as Record<string, string>,
      e2bApiBase(),
    ),
  );
  await sandbox.files.write(path, content);
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
 * `files` holds the newest {@link MAX_SESSION_FILES} heads (per-file size
 * capped); `listing` records EVERY found file (size + mtime), flagging which
 * ones were captured.
 */
export async function collectHarnessSessionFiles(
  sandboxId: string,
  provider: HarnessConfig["provider"],
): Promise<{
  files: { path: string; content: string; truncated: boolean }[];
  listing: { path: string; sizeBytes: number; mtime: string; captured: boolean }[];
}> {
  const dirs = HARNESS_SESSION_DIRS[provider] ?? [];
  if (dirs.length === 0) return { files: [], listing: [] };
  const find = await sandboxExec(
    sandboxId,
    `find ${dirs.map((d) => JSON.stringify(d)).join(" ")} -type f ` +
      `\\( -name '*.jsonl' -o -name '*.json' \\) -newer ${ATTEMPT_START_MARKER} ` +
      `-printf '%T@ %s %p\\n' 2>/dev/null | sort -rn`,
  );
  if (find.exitCode !== 0 || !find.stdout.trim()) return { files: [], listing: [] };

  const entries: { path: string; sizeBytes: number; mtime: string }[] = [];
  for (const line of find.stdout.trim().split("\n")) {
    const match = line.match(/^(\S+) (\d+) (.+)$/);
    if (!match) continue;
    entries.push({
      path: match[3] as string,
      sizeBytes: Number(match[2]),
      // find's %T@ is epoch seconds (fractional) — normalize to ISO.
      mtime: new Date(Number(match[1]) * 1000).toISOString(),
    });
  }

  const files: { path: string; content: string; truncated: boolean }[] = [];
  const captured = new Set<string>();
  for (const entry of entries.slice(0, MAX_SESSION_FILES)) {
    const read = await sandboxExec(
      sandboxId,
      `head -c ${MAX_SESSION_FILE_BYTES} ${JSON.stringify(entry.path)}`,
    );
    if (read.exitCode !== 0) continue;
    captured.add(entry.path);
    files.push({
      path: entry.path,
      content: read.stdout,
      truncated: entry.sizeBytes > MAX_SESSION_FILE_BYTES,
    });
  }
  const listing = entries.map((e) => ({ ...e, captured: captured.has(e.path) }));
  return { files, listing };
}
