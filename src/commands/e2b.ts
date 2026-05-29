import { dirname, resolve } from "node:path";
import {
  buildImageTemplate,
  buildTemplate,
  createSandbox,
  deleteTemplate,
  type E2BSandboxInfo,
  killSandbox,
  listSandboxes,
  sandboxPortUrl,
  setSandboxTimeout,
  setTemplateVisibility,
  startDetachedProcess,
  ttlRemaining,
  waitForAgentRegistration,
  waitForHttpOk,
} from "../e2b/dispatch";
import {
  absolutePath,
  DEFAULT_E2B_API_BASE,
  DEFAULT_E2B_FORWARD_KEYS,
  DEFAULT_E2B_TEMPLATE_NAMES,
  type EnvMap,
  maybeReadDotenvFile,
  parseKeyValue,
  readDotenvFile,
  redactObjectWithEnv,
  redactWithEnv,
  resolveSwarmApiKey,
  type SwarmRole,
  selectEnv,
  splitKeys,
} from "../e2b/env";

export type ParsedFlags = {
  command?: string;
  positionals: string[];
  values: Map<string, string[]>;
  booleans: Set<string>;
};

type StartedRole = {
  role: SwarmRole;
  sandbox: E2BSandboxInfo;
  url?: string;
};

/**
 * Env scope for role-scoped secret/env-file layering. A lead is E2B
 * `SwarmRole === "worker"` but gets its own `"lead"` env scope so lead and
 * worker env never cross-contaminate.
 */
export type EnvScope = "api" | "lead" | "worker";

/**
 * Per-instance launch spec threaded through {@link startRole}. `swarmRole` is
 * the E2B template/entrypoint dimension (api vs worker). `agentRole` is the
 * swarm-side role written to `AGENT_ROLE` (a lead is `swarmRole:"worker"` +
 * `agentRole:"lead"`). `envScope` selects which scoped `--{scope}-env-file` /
 * `--{scope}-secret` flags layer on top of the shared ones.
 */
export type LaunchSpec = {
  swarmRole: SwarmRole;
  agentRole?: "worker" | "lead";
  envScope: EnvScope;
};

/** The byte-identical specs for the legacy `start-api` / `start-worker` paths. */
const API_SPEC: LaunchSpec = { swarmRole: "api", envScope: "api" };
const WORKER_SPEC: LaunchSpec = { swarmRole: "worker", envScope: "worker" };

const DEFAULT_API_PORT = 3013;
const BOOLEAN_FLAGS = new Set(["dry-run", "json", "no-cache", "no-wait", "all", "yes"]);

export function parseFlags(argv: string[]): ParsedFlags {
  const [command, ...rest] = argv;
  const positionals: string[] = [];
  const values = new Map<string, string[]>();
  const booleans = new Set<string>();

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg) continue;
    if (arg === "--") {
      positionals.push(...rest.slice(i + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    if (eq > 2) {
      const key = arg.slice(2, eq);
      const value = arg.slice(eq + 1);
      values.set(key, [...(values.get(key) ?? []), value]);
      continue;
    }

    const key = arg.slice(2);
    if (BOOLEAN_FLAGS.has(key)) {
      booleans.add(key);
      continue;
    }

    const next = rest[i + 1];
    if (next && !next.startsWith("--")) {
      values.set(key, [...(values.get(key) ?? []), next]);
      i++;
    } else {
      booleans.add(key);
    }
  }

  return { command, positionals, values, booleans };
}

function value(flags: ParsedFlags, key: string, fallback = ""): string {
  return flags.values.get(key)?.at(-1) ?? fallback;
}

function values(flags: ParsedFlags, key: string): string[] {
  return flags.values.get(key) ?? [];
}

function booleanFlag(flags: ParsedFlags, key: string): boolean {
  return flags.booleans.has(key);
}

function integerFlag(flags: ParsedFlags, key: string, fallback: number): number {
  const raw = value(flags, key);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`--${key} must be a positive integer`);
  }
  return parsed;
}

async function commandOutput(args: string[], cwd: string): Promise<string | null> {
  const child = Bun.spawn(args, { cwd, stdout: "pipe", stderr: "pipe" });
  const [stdout, exitCode] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  if (exitCode !== 0) return null;
  return stdout.trim();
}

async function gitCommonRoot(cwd: string): Promise<string | null> {
  const commonDir = await commandOutput(
    ["git", "rev-parse", "--path-format=absolute", "--git-common-dir"],
    cwd,
  );
  if (!commonDir) return null;
  return commonDir.endsWith("/.git") ? dirname(commonDir) : dirname(dirname(commonDir));
}

async function loadE2BControllerEnv(
  flags: ParsedFlags,
  cwd: string,
  opts: { requireApiKey?: boolean } = {},
): Promise<EnvMap> {
  const requireApiKey = opts.requireApiKey ?? true;
  if (booleanFlag(flags, "dry-run")) {
    return { E2B_API_KEY: "dry-run" };
  }

  const explicit = value(flags, "e2b-api-key");
  const fromFile = value(flags, "e2b-api-key-file");
  const candidates: string[] = [];
  const commonRoot = await gitCommonRoot(cwd);

  if (commonRoot && commonRoot !== cwd) {
    candidates.push(resolve(commonRoot, ".env"));
    candidates.push(resolve(commonRoot, ".env.e2b"));
  }
  candidates.push(resolve(cwd, ".env"));
  candidates.push(resolve(cwd, ".env.e2b"));

  const loaded: EnvMap = {};
  for (const env of await Promise.all(
    candidates.map((candidate) => maybeReadDotenvFile(candidate)),
  )) {
    Object.assign(loaded, env);
  }

  let apiKey = explicit || process.env.E2B_API_KEY || loaded.E2B_API_KEY || "";
  if (fromFile) {
    apiKey = (await Bun.file(absolutePath(fromFile, cwd)).text()).trim();
  }
  if (!apiKey && requireApiKey) {
    throw new Error(
      "Missing E2B_API_KEY. Set it in env, pass --e2b-api-key-file, or put it in .env.e2b/.env.",
    );
  }

  const env: EnvMap = {};
  if (apiKey) env.E2B_API_KEY = apiKey;
  const domain = process.env.E2B_DOMAIN || loaded.E2B_DOMAIN;
  if (domain) env.E2B_DOMAIN = domain;
  const apiUrl =
    value(flags, "e2b-api-base") ||
    process.env.E2B_API_URL ||
    loaded.E2B_API_URL ||
    (domain ? `https://api.${domain}` : "");
  if (apiUrl) env.E2B_API_URL = apiUrl;
  const sandboxUrl = process.env.E2B_SANDBOX_URL || loaded.E2B_SANDBOX_URL;
  if (sandboxUrl) env.E2B_SANDBOX_URL = sandboxUrl;
  return env;
}

function e2bControllerApiKey(env: EnvMap): string {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("Missing E2B_API_KEY");
  }
  return apiKey;
}

function e2bApiBase(flags: ParsedFlags, controllerEnv: EnvMap): string {
  return value(flags, "e2b-api-base") || controllerEnv.E2B_API_URL || DEFAULT_E2B_API_BASE;
}

/** Read every `--{key}` env-file (repeatable) and merge them left-to-right. */
async function loadEnvFiles(flags: ParsedFlags, key: string): Promise<EnvMap> {
  const paths = values(flags, key).map((path) => absolutePath(path));
  const merged: EnvMap = {};
  for (const env of await Promise.all(paths.map((path) => readDotenvFile(path)))) {
    Object.assign(merged, env);
  }
  return merged;
}

/** Apply every `--{key} KEY=VALUE` secret (repeatable) onto `target`, in order. */
function applySecrets(flags: ParsedFlags, key: string, target: EnvMap): void {
  for (const raw of values(flags, key)) {
    const [secretKey, secretValue] = parseKeyValue(raw, `--${key}`);
    target[secretKey] = secretValue;
  }
}

export async function loadRuntimeEnv(
  flags: ParsedFlags,
  spec: LaunchSpec,
  apiUrl?: string,
): Promise<EnvMap> {
  const role = spec.swarmRole;
  const scope = spec.envScope;

  // Precedence (lowest → highest, later overrides earlier):
  //   forward-keys (process.env) < shared --env-file < scoped --{scope}-env-file
  //   < shared --secret < scoped --{scope}-secret < forced API_KEY/AGENT_SWARM_API_KEY.
  // Scoped flags LAYER ON TOP of the shared ones — they never replace them.
  const inheritKeys = [...DEFAULT_E2B_FORWARD_KEYS, ...splitKeys(values(flags, "inherit-env"))];
  const runtime: EnvMap = selectEnv(process.env, inheritKeys);

  Object.assign(runtime, await loadEnvFiles(flags, "env-file"));
  Object.assign(runtime, await loadEnvFiles(flags, `${scope}-env-file`));

  applySecrets(flags, "secret", runtime);
  applySecrets(flags, `${scope}-secret`, runtime);

  let swarmApiKey: string;
  try {
    swarmApiKey = resolveSwarmApiKey(runtime, value(flags, "api-key"));
  } catch (err) {
    if (!booleanFlag(flags, "dry-run")) throw err;
    swarmApiKey = "dry-run-api-key";
  }
  runtime.API_KEY = swarmApiKey;
  runtime.AGENT_SWARM_API_KEY = swarmApiKey;
  const startupScriptStrict = value(
    flags,
    "startup-script-strict",
    runtime.STARTUP_SCRIPT_STRICT || "",
  );
  if (startupScriptStrict) runtime.STARTUP_SCRIPT_STRICT = startupScriptStrict;

  if (role === "api") {
    runtime.PORT = value(flags, "port", String(DEFAULT_API_PORT));
    runtime.DATABASE_PATH = value(flags, "database-path", "/app/data/agent-swarm-db.sqlite");
    runtime.MIGRATIONS_DIR = value(flags, "migrations-dir", "/app/migrations");
    runtime.SQLITE_VEC_EXTENSION_PATH = value(
      flags,
      "sqlite-vec-extension-path",
      "/app/extensions/vec0.so",
    );
    runtime.SCRIPT_RUNTIME_DIR = value(flags, "script-runtime-dir", "/app/scripts-runtime");
    runtime.TS_LIB_DIR = value(flags, "ts-lib-dir", "/app/typescript-lib");
    runtime.SCRIPT_TYPES_DIR = value(flags, "script-types-dir", "/app/script-types");
  } else {
    if (!apiUrl) {
      throw new Error("Worker startup requires --api-url, or use start-stack to create API first.");
    }
    runtime.MCP_BASE_URL = apiUrl;
    // AGENT_ROLE comes from the spec (so start-stack can pin lead/worker per
    // instance); when the spec leaves it unset we fall back to the global
    // --agent-role flag, keeping start-worker byte-identical to before.
    runtime.AGENT_ROLE = spec.agentRole ?? value(flags, "agent-role", "worker");
    runtime.HARNESS_PROVIDER = value(flags, "provider", runtime.HARNESS_PROVIDER || "claude");
    runtime.WORKER_YOLO = value(flags, "worker-yolo", "false");
    runtime.WORKER_LOG_DIR = value(flags, "worker-log-dir", "/logs");
    runtime.LEAD_LOG_DIR = value(flags, "lead-log-dir", "/logs");
    runtime.HOME = value(flags, "home", runtime.HOME || "/home/worker");
    runtime.BUN_INSTALL = value(flags, "bun-install", runtime.BUN_INSTALL || "/home/worker/.bun");
    runtime.COREPACK_HOME = value(
      flags,
      "corepack-home",
      runtime.COREPACK_HOME || "/home/worker/.corepack",
    );
    runtime.PLAYWRIGHT_BROWSERS_PATH = value(
      flags,
      "playwright-browsers-path",
      runtime.PLAYWRIGHT_BROWSERS_PATH || "/opt/playwright",
    );
    runtime.PI_PACKAGE_DIR = value(
      flags,
      "pi-package-dir",
      runtime.PI_PACKAGE_DIR || "/usr/lib/node_modules/@earendil-works/pi-coding-agent",
    );
    runtime.CODEX_PATH_OVERRIDE = value(
      flags,
      "codex-path-override",
      runtime.CODEX_PATH_OVERRIDE || "/usr/bin/codex",
    );
    runtime.PATH = value(
      flags,
      "path",
      runtime.PATH ||
        [
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
    );
  }

  delete runtime.E2B_API_KEY;
  delete runtime.E2B_ACCESS_TOKEN;
  return runtime;
}

function parseMetadata(flags: ParsedFlags, role: SwarmRole): Record<string, string> {
  const metadata: Record<string, string> = {
    app: "agent-swarm",
    role,
    launcher: "agent-swarm-e2b",
  };
  for (const raw of values(flags, "metadata")) {
    const [key, metadataValue] = parseKeyValue(raw, "--metadata");
    metadata[key] = metadataValue;
  }
  return metadata;
}

function roleTemplate(flags: ParsedFlags, role: SwarmRole): string {
  return value(
    flags,
    `${role}-template`,
    value(flags, "template", DEFAULT_E2B_TEMPLATE_NAMES[role]),
  );
}

function localDockerfile(role: SwarmRole): string {
  return role === "api" ? "Dockerfile" : "Dockerfile.worker";
}

function formatDuration(secondsLeft: number): string {
  if (secondsLeft <= 0) return "expired";
  const hours = Math.floor(secondsLeft / 3600);
  const minutes = Math.floor((secondsLeft % 3600) / 60);
  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  // Always show minutes when under an hour, otherwise show them alongside hours.
  if (minutes > 0 || hours === 0) parts.push(`${minutes}m`);
  return parts.join(" ");
}

function printHumanStart(result: StartedRole, env: EnvMap): void {
  console.log(`${result.role} sandbox: ${result.sandbox.sandboxID}`);
  if (result.url) console.log(`${result.role} url: ${result.url}`);
  const ttl = ttlRemaining(result.sandbox);
  if (ttl.expiresAt && ttl.secondsLeft !== undefined) {
    console.log(`${result.role} expires: ${ttl.expiresAt} (in ${formatDuration(ttl.secondsLeft)})`);
  }
  console.log(
    redactWithEnv(`inspect: e2b sandbox info ${result.sandbox.sandboxID} --format json`, env),
  );
}

function publicStartedRole(result: StartedRole, env: EnvMap): StartedRole {
  const { envdAccessToken, trafficAccessToken, ...sandbox } = result.sandbox;
  void envdAccessToken;
  void trafficAccessToken;
  return redactObjectWithEnv({ ...result, sandbox }, env);
}

async function startRole(
  flags: ParsedFlags,
  cwd: string,
  spec: LaunchSpec,
  apiUrl?: string,
): Promise<StartedRole> {
  const role = spec.swarmRole;
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const runtimeEnv = await loadRuntimeEnv(flags, spec, apiUrl);
  const controllerApiKey = e2bControllerApiKey(controllerEnv);
  const template = roleTemplate(flags, role);
  const timeoutSec = integerFlag(flags, "timeout-sec", 3600);
  const apiBase = e2bApiBase(flags, controllerEnv);
  const dryRun = booleanFlag(flags, "dry-run");
  const port = Number.parseInt(runtimeEnv.PORT || String(DEFAULT_API_PORT), 10);
  const metadata = parseMetadata(flags, role);

  if (dryRun) {
    const fakeSandbox = {
      sandboxID: "dry-run",
      templateID: template,
      envdAccessToken: "dry-run",
      domain: "e2b.app",
      metadata,
      expiresAt: new Date(Date.now() + timeoutSec * 1000).toISOString(),
    };
    return {
      role,
      sandbox: fakeSandbox,
      url: role === "api" ? sandboxPortUrl(fakeSandbox, port, controllerEnv) : undefined,
    };
  }

  const sandbox = await createSandbox({
    apiKey: controllerApiKey,
    apiBase,
    template,
    timeoutSec,
    envVars: runtimeEnv,
    metadata,
  });

  try {
    if (role === "worker" && !runtimeEnv.AGENT_ID) {
      runtimeEnv.AGENT_ID = value(flags, "agent-id", `e2b-${sandbox.sandboxID}`);
    }

    const entrypoint = role === "api" ? "/api-entrypoint.sh" : "/docker-entrypoint.sh";
    await startDetachedProcess({
      sandbox,
      apiKey: controllerApiKey,
      apiBase,
      e2bEnv: controllerEnv,
      env: runtimeEnv,
      command: entrypoint,
      role,
      cwd: role === "api" ? "/app" : "/workspace",
    });

    const url = role === "api" ? sandboxPortUrl(sandbox, port, controllerEnv) : undefined;
    if (role === "api" && !booleanFlag(flags, "no-wait")) {
      await waitForHttpOk(`${url}/health`, integerFlag(flags, "wait-ms", 90_000));
    }
    if (role === "worker" && !booleanFlag(flags, "no-wait")) {
      const agentId = runtimeEnv.AGENT_ID;
      const swarmApiKey = runtimeEnv.AGENT_SWARM_API_KEY;
      if (!apiUrl || !agentId || !swarmApiKey) {
        throw new Error("Worker startup did not resolve API URL, agent ID, or swarm API key");
      }
      await waitForAgentRegistration(
        apiUrl,
        agentId,
        swarmApiKey,
        integerFlag(flags, "wait-ms", 90_000),
      );
    }
    return { role, sandbox, url };
  } catch (err) {
    try {
      await killSandbox(sandbox.sandboxID, controllerApiKey, apiBase);
    } catch (cleanupErr) {
      const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(
        redactWithEnv(
          `e2b: failed to clean up sandbox ${sandbox.sandboxID} after startup failure: ${message}`,
          controllerEnv,
        ),
      );
    }
    throw err;
  }
}

async function buildTemplateCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const role = (value(flags, "role") || flags.positionals[0]) as SwarmRole;
  if (role !== "api" && role !== "worker") {
    throw new Error("build-template requires --role api|worker");
  }

  const source = value(flags, "source", "local");
  const templateName = roleTemplate(flags, role);
  const buildArgs: Record<string, string> = {};
  let dockerfile = value(flags, "dockerfile");
  if (!dockerfile) {
    dockerfile = localDockerfile(role);
  }

  if (source === "image") {
    const image = value(flags, "image");
    if (!image) throw new Error("Image-backed template builds require --image <image>");
    const result = await buildImageTemplate({
      role,
      name: templateName,
      image,
      cpuCount: integerFlag(flags, "cpu-count", role === "worker" ? 4 : 2),
      memoryMb: integerFlag(flags, "memory-mb", role === "worker" ? 8192 : 2048),
      noCache: booleanFlag(flags, "no-cache"),
      e2bEnv: await loadE2BControllerEnv(flags, cwd),
      dryRun: booleanFlag(flags, "dry-run"),
    });

    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`e2b image template build failed with exit code ${result.exitCode}`);
    }
    return;
  }

  if (source !== "local") {
    throw new Error("--source must be local or image");
  }

  for (const raw of values(flags, "build-arg")) {
    const [key, argValue] = parseKeyValue(raw, "--build-arg");
    buildArgs[key] = argValue;
  }
  if (Object.keys(buildArgs).length > 0) {
    throw new Error("E2B template create does not support --build-arg; use --source image instead");
  }

  const controllerEnv = await loadE2BControllerEnv(flags, cwd, { requireApiKey: false });
  const result = await buildTemplate({
    role,
    name: templateName,
    dockerfile,
    cwd,
    cpuCount: integerFlag(flags, "cpu-count", role === "worker" ? 4 : 2),
    memoryMb: integerFlag(flags, "memory-mb", role === "worker" ? 8192 : 2048),
    noCache: booleanFlag(flags, "no-cache"),
    e2bEnv: controllerEnv,
    dryRun: booleanFlag(flags, "dry-run"),
  });

  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.exitCode !== 0) {
    throw new Error(`e2b template build failed with exit code ${result.exitCode}`);
  }
}

async function deleteTemplateCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const names = flags.positionals;
  if (names.length === 0) throw new Error("delete-template requires at least one template name");
  const controllerEnv = await loadE2BControllerEnv(flags, cwd, { requireApiKey: false });

  for (const name of names) {
    const result = await deleteTemplate({
      name,
      e2bEnv: controllerEnv,
      dryRun: booleanFlag(flags, "dry-run"),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`e2b template delete failed for ${name} with exit code ${result.exitCode}`);
    }
  }
}

async function templateVisibilityCommand(
  flags: ParsedFlags,
  cwd: string,
  isPublic: boolean,
): Promise<void> {
  const names = flags.positionals;
  const action = isPublic ? "publish-template" : "unpublish-template";
  if (names.length === 0) throw new Error(`${action} requires at least one template name`);
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);

  for (const name of names) {
    const result = await setTemplateVisibility({
      name,
      public: isPublic,
      e2bEnv: controllerEnv,
      dryRun: booleanFlag(flags, "dry-run"),
    });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    if (result.exitCode !== 0) {
      throw new Error(`e2b template visibility update failed for ${name}`);
    }
  }
}

async function startApiCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const result = await startRole(flags, cwd, API_SPEC);
  const runtimeEnv = await loadRuntimeEnv(flags, API_SPEC);
  if (booleanFlag(flags, "json")) {
    console.log(JSON.stringify(publicStartedRole(result, runtimeEnv), null, 2));
  } else {
    printHumanStart(result, runtimeEnv);
  }
}

async function startWorkerCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const apiUrl = value(flags, "api-url");
  const result = await startRole(flags, cwd, WORKER_SPEC, apiUrl);
  const runtimeEnv = await loadRuntimeEnv(flags, WORKER_SPEC, apiUrl);
  if (booleanFlag(flags, "json")) {
    console.log(JSON.stringify(publicStartedRole(result, runtimeEnv), null, 2));
  } else {
    printHumanStart(result, runtimeEnv);
  }
}

async function cleanupStartedRoles(
  flags: ParsedFlags,
  cwd: string,
  started: StartedRole[],
): Promise<void> {
  if (booleanFlag(flags, "dry-run") || started.length === 0) return;

  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const controllerApiKey = e2bControllerApiKey(controllerEnv);
  const apiBase = e2bApiBase(flags, controllerEnv);

  for (const role of [...started].reverse()) {
    try {
      await killSandbox(role.sandbox.sandboxID, controllerApiKey, apiBase);
    } catch (cleanupErr) {
      const message = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      console.warn(
        redactWithEnv(
          `e2b: failed to clean up ${role.role} sandbox ${role.sandbox.sandboxID} after stack startup failure: ${message}`,
          controllerEnv,
        ),
      );
    }
  }
}

async function resyncStackTimeout(
  flags: ParsedFlags,
  cwd: string,
  started: StartedRole[],
): Promise<void> {
  if (booleanFlag(flags, "dry-run") || started.length === 0) return;

  const timeoutSec = integerFlag(flags, "timeout-sec", 3600);
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const controllerApiKey = e2bControllerApiKey(controllerEnv);
  const apiBase = e2bApiBase(flags, controllerEnv);

  for (const role of started) {
    try {
      await setSandboxTimeout({
        sandboxId: role.sandbox.sandboxID,
        apiKey: controllerApiKey,
        apiBase,
        e2bEnv: controllerEnv,
        timeoutMs: timeoutSec * 1000,
      });
    } catch (err) {
      // A re-sync failure is non-fatal — the sandbox is still up with its
      // original (slightly shorter) TTL. setSandboxTimeout already redacts.
      const message = err instanceof Error ? err.message : String(err);
      console.warn(
        redactWithEnv(
          `e2b: failed to re-sync TTL for ${role.role} sandbox ${role.sandbox.sandboxID}: ${message}`,
          controllerEnv,
        ),
      );
    }
  }
}

async function startStackCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const started: StartedRole[] = [];
  const workers: StartedRole[] = [];

  try {
    const api = await startRole(flags, cwd, API_SPEC);
    started.push(api);
    if (!api.url) throw new Error("API sandbox did not produce a public URL");

    const workerCount = integerFlag(flags, "workers", 1);
    for (let i = 0; i < workerCount; i++) {
      // Phase 3 splits this into a lead + workers; for now every member of the
      // stack uses the worker spec, preserving the legacy homogeneous topology.
      const worker = await startRole(flags, cwd, WORKER_SPEC, api.url);
      workers.push(worker);
      started.push(worker);
    }

    // Re-sync the whole stack to a single wall-clock TTL. The API sandbox is
    // created first, so by the time the last worker is up its remaining TTL is
    // shorter than the API's. One setSandboxTimeout pass aligns every sandbox
    // to `timeoutSec` from now (E2B clamps to the tier max as usual). Dry-run
    // short-circuits — never touches E2B.
    await resyncStackTimeout(flags, cwd, started);

    const runtimeEnv = await loadRuntimeEnv(flags, API_SPEC);

    if (booleanFlag(flags, "json")) {
      console.log(
        JSON.stringify(
          {
            api: publicStartedRole(api, runtimeEnv),
            workers: workers.map((worker) => publicStartedRole(worker, runtimeEnv)),
          },
          null,
          2,
        ),
      );
    } else {
      printHumanStart(api, runtimeEnv);
      for (const worker of workers) {
        printHumanStart(worker, runtimeEnv);
      }
    }
  } catch (err) {
    await cleanupStartedRoles(flags, cwd, started);
    throw err;
  }
}

function isInteractiveTty(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY);
}

/**
 * Prompt for a yes/no confirmation on an interactive TTY. Returns true when the
 * operator answers "y"/"yes". In a non-TTY (CI, piped) context there is no one
 * to ask, so we require an explicit `--yes` to proceed and otherwise refuse.
 */
async function confirm(prompt: string, flags: ParsedFlags): Promise<boolean> {
  if (booleanFlag(flags, "yes")) return true;
  if (!isInteractiveTty()) return false;
  process.stdout.write(`${prompt} [y/N] `);
  for await (const line of console) {
    const answer = line.trim().toLowerCase();
    return answer === "y" || answer === "yes";
  }
  return false;
}

async function extendCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const ids = flags.positionals;
  if (ids.length === 0) throw new Error("extend requires at least one sandbox ID");
  const timeoutSec = integerFlag(flags, "timeout-sec", 3600);
  const dryRun = booleanFlag(flags, "dry-run");

  if (dryRun) {
    // Short-circuit before any SDK/network work so --dry-run never touches E2B.
    for (const id of ids) {
      console.log(`would extend ${id} to ${timeoutSec}s TTL`);
    }
    return;
  }

  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const controllerApiKey = e2bControllerApiKey(controllerEnv);
  const apiBase = e2bApiBase(flags, controllerEnv);

  let failures = 0;
  for (const id of ids) {
    try {
      const ttl = await setSandboxTimeout({
        sandboxId: id,
        apiKey: controllerApiKey,
        apiBase,
        e2bEnv: controllerEnv,
        timeoutMs: timeoutSec * 1000,
      });
      if (ttl.expiresAt && ttl.secondsLeft !== undefined) {
        console.log(
          `extended ${id} — expires ${ttl.expiresAt} (in ${formatDuration(ttl.secondsLeft)})`,
        );
      } else {
        console.log(`extended ${id}`);
      }
    } catch (err) {
      failures++;
      // setSandboxTimeout already produces a redacted message.
      const message = err instanceof Error ? err.message : String(err);
      console.error(redactWithEnv(`e2b: extend failed: ${message}`, controllerEnv));
    }
  }
  if (failures > 0) {
    throw new Error(`extend failed for ${failures} of ${ids.length} sandbox(es)`);
  }
}

async function killCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const apiBase = e2bApiBase(flags, controllerEnv);
  const controllerApiKey = e2bControllerApiKey(controllerEnv);

  let ids = flags.positionals;

  if (booleanFlag(flags, "all")) {
    // Sweep everything this dispatcher launched. The launcher tag is stamped on
    // every sandbox by parseMetadata, so this never touches unrelated sandboxes.
    const sandboxes = await listSandboxes(controllerApiKey, apiBase);
    ids = sandboxes
      .filter((sandbox) => sandbox.metadata?.launcher === "agent-swarm-e2b")
      .map((sandbox) => sandbox.sandboxID);
    if (ids.length === 0) {
      console.log("no agent-swarm sandboxes to kill");
      return;
    }
    // Guard against an accidental fleet-wide teardown. A single target is
    // unambiguous; multiple targets require confirmation (or --yes in CI).
    if (ids.length > 1) {
      const ok = await confirm(
        `Kill ${ids.length} agent-swarm sandboxes (${ids.join(", ")})?`,
        flags,
      );
      if (!ok) {
        console.log("aborted (pass --yes to skip this prompt)");
        return;
      }
    }
  }

  if (ids.length === 0) throw new Error("kill requires at least one sandbox ID (or --all)");

  for (const id of ids) {
    await killSandbox(id, controllerApiKey, apiBase);
    console.log(`killed ${id}`);
  }
}

async function listCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const apiBase = e2bApiBase(flags, controllerEnv);
  const sandboxes = await listSandboxes(e2bControllerApiKey(controllerEnv), apiBase);
  if (booleanFlag(flags, "json")) {
    console.log(JSON.stringify(redactObjectWithEnv(sandboxes, controllerEnv), null, 2));
    return;
  }
  for (const sandbox of sandboxes) {
    console.log(
      `${sandbox.sandboxID}\t${sandbox.alias ?? sandbox.templateID}\t${sandbox.metadata?.role ?? ""}`,
    );
  }
}

function printE2BHelp(): void {
  console.log(`
agent-swarm e2b

Usage:
  agent-swarm e2b build-template --role api|worker [--source local|image]
  agent-swarm e2b delete-template <template-name...>
  agent-swarm e2b publish-template <template-name...>
  agent-swarm e2b unpublish-template <template-name...>
  agent-swarm e2b start-api --template <template> [--env-file .env]
  agent-swarm e2b start-worker --template <template> --api-url <https-url> [--env-file .env]
  agent-swarm e2b start-stack --api-template <template> --worker-template <template> [--workers 1]
  agent-swarm e2b list [--json]
  agent-swarm e2b extend <sandbox-id...> --timeout-sec <seconds>
  agent-swarm e2b kill <sandbox-id...> | --all

Common options:
  --env-file <path>          Load runtime env/secrets for all roles (repeatable)
  --secret KEY=VALUE         Add/override one runtime secret for all roles (repeatable)
  --inherit-env KEY[,KEY]    Forward extra local env vars into the sandbox
  --api-key <key>            Swarm API key passed to API/worker (required unless env provides one)
  --agent-id <id>            Worker agent ID (default: e2b-<sandbox-id>)
  --agent-role worker|lead   Role the worker sandbox runs as (default worker)
  --provider <name>          Harness provider for workers (default claude)
  --workers <n>              Worker count for start-stack (default 1)
  --timeout-sec <seconds>    Sandbox TTL (default 3600); for extend, the new TTL from now
  --no-wait                  Skip waiting for API health / worker registration
  --e2b-api-key-file <path>  Read the E2B controller API key from a file

Role-scoped env (layer ON TOP of the shared --env-file/--secret, never replace):
  --api-env-file <path>      Env file applied only to the API sandbox (repeatable)
  --lead-env-file <path>     Env file applied only to the lead sandbox (repeatable)
  --worker-env-file <path>   Env file applied only to worker sandboxes (repeatable)
  --api-secret KEY=VALUE     Secret applied only to the API sandbox (repeatable)
  --lead-secret KEY=VALUE    Secret applied only to the lead sandbox (repeatable)
  --worker-secret KEY=VALUE  Secret applied only to worker sandboxes (repeatable)
  Precedence (highest wins): forward-keys < --env-file < --<scope>-env-file
    < --secret < --<scope>-secret < forced API_KEY/AGENT_SWARM_API_KEY.

extend:
  Extend (or reduce) a live sandbox's TTL. E2B clamps to your tier max, so the
  printed expiry reflects what was actually applied. --dry-run never contacts E2B.

kill:
  --all                      Kill every sandbox launched by this dispatcher
                             (metadata.launcher === agent-swarm-e2b)
  --yes                      Skip the multi-sandbox confirmation prompt (required in CI)

Global:
  --json                     Print machine-readable output
  --dry-run                  Print/derive planned work without touching E2B
`);
}

export async function runE2BCommand(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const cwd = process.cwd();
  try {
    switch (flags.command) {
      case undefined:
      case "help":
        printE2BHelp();
        return;
      case "build-template":
        await buildTemplateCommand(flags, cwd);
        return;
      case "delete-template":
        await deleteTemplateCommand(flags, cwd);
        return;
      case "publish-template":
        await templateVisibilityCommand(flags, cwd, true);
        return;
      case "unpublish-template":
        await templateVisibilityCommand(flags, cwd, false);
        return;
      case "start-api":
        await startApiCommand(flags, cwd);
        return;
      case "start-worker":
        await startWorkerCommand(flags, cwd);
        return;
      case "start-stack":
        await startStackCommand(flags, cwd);
        return;
      case "list":
        await listCommand(flags, cwd);
        return;
      case "extend":
        await extendCommand(flags, cwd);
        return;
      case "kill":
        await killCommand(flags, cwd);
        return;
      default:
        throw new Error(`Unknown e2b subcommand: ${flags.command}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`e2b: ${message}`);
    process.exitCode = 1;
  }
}
