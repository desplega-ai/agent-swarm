import { dirname, resolve } from "node:path";
import { render } from "ink";
import { createElement } from "react";
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
import {
  DEFAULT_STACK_TIMEOUT_SEC,
  DEFAULT_STACK_WORKERS,
  STACK_INTEGRATIONS,
  StackWizard,
  type StackWizardDefaults,
  type StackWizardResult,
  type StackWizardSkips,
  slugify,
} from "./e2b-stack-wizard.tsx";

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
  /**
   * Flag the explicit AGENT_ID override is read from (default `"agent-id"`).
   * The stack's lead reads `"lead-agent-id"` so a single `--agent-id` never
   * collides the lead and a worker onto the same agent record.
   */
  agentIdFlag?: string;
  /**
   * Prefix for the generated default AGENT_ID (`<prefix>-<sandboxID>`). Workers
   * use `"e2b"` (legacy, unchanged); the stack's lead uses `"e2b-lead"`. The
   * sandbox ID is unique per sandbox, so every instance still registers
   * distinctly even without an explicit `--agent-id`.
   */
  agentIdPrefix?: string;
};

/** The byte-identical specs for the legacy `start-api` / `start-worker` paths. */
const API_SPEC: LaunchSpec = { swarmRole: "api", envScope: "api" };
const WORKER_SPEC: LaunchSpec = { swarmRole: "worker", envScope: "worker" };

/**
 * Stack-specific specs. The lead is E2B `SwarmRole === "worker"` (same template
 * + entrypoint) but pins `agentRole:"lead"`, its own `"lead"` env scope, and a
 * dedicated `--lead-agent-id` override + `e2b-lead-<sandboxID>` default.
 */
const STACK_LEAD_SPEC: LaunchSpec = {
  swarmRole: "worker",
  agentRole: "lead",
  envScope: "lead",
  agentIdFlag: "lead-agent-id",
  agentIdPrefix: "e2b-lead",
};
const STACK_WORKER_SPEC: LaunchSpec = {
  swarmRole: "worker",
  agentRole: "worker",
  envScope: "worker",
};

const DEFAULT_API_PORT = 3013;
const BOOLEAN_FLAGS = new Set([
  "dry-run",
  "json",
  "no-cache",
  "no-wait",
  "all",
  "yes",
  "non-interactive",
  "no-lead",
  // Integration disable shortcuts: `--no-<integration>` sets the matching
  // API-side `*_DISABLE=true`. The `--integrations <csv>` allowlist is the
  // value-bearing alternative (handled separately).
  "no-slack",
  "no-github",
  "no-jira",
  "no-linear",
]);

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

/** Integrations toggleable via `--integrations <csv>` / `--no-<integration>`. */
const E2B_INTEGRATIONS = ["slack", "github", "jira", "linear"] as const;
type E2BIntegration = (typeof E2B_INTEGRATIONS)[number];

/**
 * Resolve which integrations are enabled. Default: all on. `--integrations
 * <csv>` is an allowlist — anything not listed is disabled. `--no-<integration>`
 * disables a single one (and stacks on top of the allowlist). Returns a map of
 * integration → enabled.
 */
export function resolveIntegrationToggles(flags: ParsedFlags): Record<E2BIntegration, boolean> {
  const allowlistRaw = splitKeys(values(flags, "integrations")).map((s) => s.toLowerCase());
  const hasAllowlist = allowlistRaw.length > 0;
  const toggles = {} as Record<E2BIntegration, boolean>;
  for (const integration of E2B_INTEGRATIONS) {
    // With an allowlist, only listed integrations stay on; without one, all on.
    let enabled = hasAllowlist ? allowlistRaw.includes(integration) : true;
    if (booleanFlag(flags, `no-${integration}`)) enabled = false;
    toggles[integration] = enabled;
  }
  return toggles;
}

/**
 * Stamp `*_DISABLE=true` for any integration the operator turned off. These envs
 * are read API-side, so the caller only applies this to the API runtime scope.
 */
function applyIntegrationDisables(flags: ParsedFlags, target: EnvMap): void {
  const toggles = resolveIntegrationToggles(flags);
  for (const integration of E2B_INTEGRATIONS) {
    if (!toggles[integration]) {
      target[`${integration.toUpperCase()}_DISABLE`] = "true";
    }
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
    // Integration toggles are read API-side, so they only ever apply to the API
    // sandbox's runtime env. `--no-<integration>` / `--integrations <csv>`
    // resolve to `*_DISABLE=true` here.
    applyIntegrationDisables(flags, runtime);
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
      // Per-instance AGENT_ID. The explicit-override flag and the generated
      // default prefix come from the spec so the stack's lead never collides
      // with a worker (lead → --lead-agent-id / e2b-lead-<id>; worker →
      // --agent-id / e2b-<id>). Sandbox IDs are unique, so each instance
      // registers distinctly even without an explicit override.
      const agentIdFlag = spec.agentIdFlag ?? "agent-id";
      const agentIdPrefix = spec.agentIdPrefix ?? "e2b";
      runtimeEnv.AGENT_ID = value(flags, agentIdFlag, `${agentIdPrefix}-${sandbox.sandboxID}`);
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

/**
 * `start-stack` should run headless (no prompts, never read stdin) whenever:
 *   - `--yes` / `--non-interactive` is passed,
 *   - `--dry-run` is passed (CI/preview path), or
 *   - we're not on an interactive TTY (piped / redirected stdin or stdout).
 * Critically, the piped case (`echo | … start-stack …`) MUST take this path so
 * it exits without hanging on a prompt that no one can answer.
 */
function isStackHeadless(flags: ParsedFlags): boolean {
  return (
    booleanFlag(flags, "yes") ||
    booleanFlag(flags, "non-interactive") ||
    booleanFlag(flags, "dry-run") ||
    !isInteractiveTty()
  );
}

async function startStackCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  // `--agent-role` is meaningless for the split topology (API + lead + workers
  // each get a fixed role). Warn and point the operator at the right tool
  // rather than silently ignoring an intent to change roles.
  if (value(flags, "agent-role")) {
    console.warn(
      "e2b start-stack: --agent-role is ignored (the stack pins API/lead/worker roles). " +
        "Use --no-lead for an API + workers topology, or start-worker --agent-role for a single custom-role worker.",
    );
  }

  // Normalize a provided --swarm into a clean slug so the value is consistent
  // whether it came from a flag or the wizard. (Phase 4 stamps it onto sandbox
  // metadata; Phase 3 only uses it for wizard naming + the echoed command.)
  const swarmFlag = value(flags, "swarm");
  if (swarmFlag) setFlagValue(flags, "swarm", slugify(swarmFlag));

  // Interactive wizard (TTY only). Headless runs (--yes / --non-interactive /
  // --dry-run / non-TTY) skip it entirely and rely on flags + defaults.
  if (!isStackHeadless(flags)) {
    await runStackWizard(flags);
  }

  const noLead = booleanFlag(flags, "no-lead");
  const started: StartedRole[] = [];
  let lead: StartedRole | undefined;
  const workers: StartedRole[] = [];

  try {
    const api = await startRole(flags, cwd, API_SPEC);
    started.push(api);
    if (!api.url) throw new Error("API sandbox did not produce a public URL");

    // (2) One lead, unless --no-lead retains the legacy homogeneous topology.
    if (!noLead) {
      lead = await startRole(flags, cwd, STACK_LEAD_SPEC, api.url);
      // The lead MUST be in `started[]` so a mid-launch failure tears it down,
      // and so the TTL re-sync pass below covers it.
      started.push(lead);
    }

    // (3) N workers.
    const workerCount = integerFlag(flags, "workers", 1);
    for (let i = 0; i < workerCount; i++) {
      const worker = await startRole(flags, cwd, STACK_WORKER_SPEC, api.url);
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
      // Legacy shape under --no-lead: {api, workers}. New shape with a lead:
      // {api, lead, workers}.
      const payload: Record<string, unknown> = {
        api: publicStartedRole(api, runtimeEnv),
      };
      if (lead) payload.lead = publicStartedRole(lead, runtimeEnv);
      payload.workers = workers.map((worker) => publicStartedRole(worker, runtimeEnv));
      console.log(JSON.stringify(payload, null, 2));
    } else {
      printHumanStart(api, runtimeEnv);
      if (lead) printHumanStart(lead, runtimeEnv);
      for (const worker of workers) {
        printHumanStart(worker, runtimeEnv);
      }
    }
  } catch (err) {
    await cleanupStartedRoles(flags, cwd, started);
    throw err;
  }
}

/** Set/replace a single-value flag in place (mirrors `--key value`). */
function setFlagValue(flags: ParsedFlags, key: string, value: string): void {
  flags.values.set(key, [value]);
}

/**
 * Compute which wizard steps to skip because the operator already supplied the
 * value on the command line. A step is skipped when its driving flag is present.
 */
function stackWizardSkips(flags: ParsedFlags): StackWizardSkips {
  return {
    swarm: Boolean(value(flags, "swarm")),
    workers: flags.values.has("workers"),
    provider: flags.values.has("provider"),
    timeout: flags.values.has("timeout-sec"),
    envFiles: flags.values.has("env-file"),
    integrations:
      flags.values.has("integrations") ||
      STACK_INTEGRATIONS.some((i) => booleanFlag(flags, `no-${i}`)),
  };
}

/** Seed the wizard with whatever the flags already resolve to. */
function stackWizardDefaults(flags: ParsedFlags): StackWizardDefaults {
  return {
    swarmSlug: value(flags, "swarm") || undefined,
    workers: integerFlag(flags, "workers", DEFAULT_STACK_WORKERS),
    provider: value(flags, "provider", "claude"),
    timeoutSec: integerFlag(flags, "timeout-sec", DEFAULT_STACK_TIMEOUT_SEC),
    envFiles: values(flags, "env-file"),
    integrations: resolveIntegrationToggles(flags),
    noLead: booleanFlag(flags, "no-lead"),
  };
}

/**
 * Fold the wizard's answers back onto `flags` so the single headless launch
 * path below picks them up. Only values the wizard actually collected are
 * written; flag-provided values were skipped in the wizard and remain as-is.
 */
function applyWizardResultToFlags(flags: ParsedFlags, result: StackWizardResult): void {
  setFlagValue(flags, "swarm", result.swarmSlug);
  setFlagValue(flags, "workers", String(result.workers));
  setFlagValue(flags, "provider", result.provider);
  setFlagValue(flags, "timeout-sec", String(result.timeoutSec));
  if (result.envFiles.length > 0) {
    flags.values.set("env-file", result.envFiles);
  }
  // A disabled integration becomes `--no-<integration>` (→ API `*_DISABLE`).
  for (const integration of STACK_INTEGRATIONS) {
    if (!result.integrations[integration]) {
      flags.booleans.add(`no-${integration}`);
    }
  }
  if (result.noLead) flags.booleans.add("no-lead");
}

/**
 * Reconstruct the equivalent headless one-shot command from the resolved flags,
 * so an operator who ran the wizard can copy/paste it for a repeatable CI run.
 * Secrets are NOT included — only the topology-shaping flags the wizard sets.
 */
function buildOneShotCommand(flags: ParsedFlags): string {
  const parts = ["agent-swarm e2b start-stack --yes"];
  const slug = value(flags, "swarm");
  if (slug) parts.push(`--swarm ${slug}`);
  parts.push(`--workers ${integerFlag(flags, "workers", DEFAULT_STACK_WORKERS)}`);
  const provider = value(flags, "provider");
  if (provider) parts.push(`--provider ${provider}`);
  parts.push(`--timeout-sec ${integerFlag(flags, "timeout-sec", DEFAULT_STACK_TIMEOUT_SEC)}`);
  for (const file of values(flags, "env-file")) {
    parts.push(`--env-file ${file}`);
  }
  for (const integration of STACK_INTEGRATIONS) {
    if (booleanFlag(flags, `no-${integration}`)) parts.push(`--no-${integration}`);
  }
  if (booleanFlag(flags, "no-lead")) parts.push("--no-lead");
  return parts.join(" ");
}

/**
 * Render the Ink wizard, await the operator's answers, fold them onto `flags`,
 * and echo the equivalent `--yes` command. Only called on an interactive TTY
 * (see {@link isStackHeadless}).
 */
async function runStackWizard(flags: ParsedFlags): Promise<void> {
  const skips = stackWizardSkips(flags);
  const defaults = stackWizardDefaults(flags);

  let resolved: StackWizardResult | undefined;
  const instance = render(
    createElement(StackWizard, {
      defaults,
      skips,
      onComplete: (result: StackWizardResult) => {
        resolved = result;
      },
    }),
  );
  await instance.waitUntilExit();

  if (!resolved) {
    throw new Error("stack wizard exited without producing a configuration");
  }
  applyWizardResultToFlags(flags, resolved);

  console.log("\nEquivalent one-shot command:");
  console.log(`  ${buildOneShotCommand(flags)}\n`);
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
  agent-swarm e2b start-api [--template <name>] [--env-file .env]
  agent-swarm e2b start-worker --api-url <https-url> [--template <name>] [--env-file .env]
  agent-swarm e2b start-stack [--swarm <slug>] [--workers <n>] [--no-lead] [--yes]
  agent-swarm e2b list [--json]
  agent-swarm e2b extend <sandbox-id...> --timeout-sec <seconds>
  agent-swarm e2b kill <sandbox-id...> | --all

Common options:
  --env-file <path>          Load runtime env/secrets for all roles (repeatable)
  --secret KEY=VALUE         Add/override one runtime secret for all roles (repeatable)
  --inherit-env KEY[,KEY]    Forward extra local env vars into the sandbox
  --api-key <key>            Swarm API key for API/worker (required unless env provides one)
  --api-url <https-url>      Public API URL a worker connects to (start-worker)
  --agent-id <id>            Worker agent ID (default: e2b-<sandbox-id>)
  --agent-role worker|lead   Role for start-worker (ignored by start-stack)
  --provider <name>          Harness provider for workers (default claude)
  --template <name>          Override the E2B template for the role
  --api-template / --worker-template <name>   Per-role E2B template overrides
  --timeout-sec <seconds>    Sandbox TTL (default 3600); for extend, the new TTL from now
  --no-wait                  Skip waiting for API health / worker registration
  --e2b-api-key-file <path>  Read the E2B controller API key from a file

start-stack (API + lead + N workers):
  Provisions an API, one lead, and N workers. Interactive wizard on a TTY;
  headless under --yes / --non-interactive / --dry-run / a non-TTY.
  --swarm <slug>             Swarm name/slug (used for the wizard + echoed command)
  --workers <n>              Worker count (default 1)
  --no-lead                  Legacy topology: API + N workers, no lead
  --lead-agent-id <id>       Lead agent ID (default: e2b-lead-<sandbox-id>)
  --yes                      Skip the wizard; use flags + defaults (CI/headless)
  --non-interactive          Same as --yes for prompting (never reads stdin)
  --integrations <csv>       Allowlist of integrations to keep on (slack,github,jira,linear)
  --no-slack / --no-github / --no-jira / --no-linear
                             Disable an integration (sets the API's <NAME>_DISABLE=true)
  JSON shape: {api, lead, workers:[...]} — or {api, workers:[...]} with --no-lead.

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
