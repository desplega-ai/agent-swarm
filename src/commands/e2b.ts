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
  setTemplateVisibility,
  startDetachedProcess,
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

type ParsedFlags = {
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

const DEFAULT_API_PORT = 3013;
const BOOLEAN_FLAGS = new Set(["dry-run", "json", "no-cache", "no-wait"]);

function parseFlags(argv: string[]): ParsedFlags {
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
    return { E2B_ACCESS_TOKEN: "dry-run", E2B_API_KEY: "dry-run" };
  }

  const explicit = value(flags, "e2b-api-key");
  const fromFile = value(flags, "e2b-api-key-file");
  const explicitAccessToken = value(flags, "e2b-access-token");
  const accessTokenFile = value(flags, "e2b-access-token-file");
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
  let accessToken =
    explicitAccessToken || process.env.E2B_ACCESS_TOKEN || loaded.E2B_ACCESS_TOKEN || "";
  if (accessTokenFile) {
    accessToken = (await Bun.file(absolutePath(accessTokenFile, cwd)).text()).trim();
  }
  if (!apiKey && requireApiKey) {
    throw new Error(
      "Missing E2B_API_KEY. Set it in env, pass --e2b-api-key-file, or put it in .env.e2b/.env.",
    );
  }

  const env: EnvMap = {};
  if (apiKey) env.E2B_API_KEY = apiKey;
  if (accessToken) env.E2B_ACCESS_TOKEN = accessToken;
  const domain = process.env.E2B_DOMAIN || loaded.E2B_DOMAIN;
  if (domain) env.E2B_DOMAIN = domain;
  return env;
}

function e2bControllerApiKey(env: EnvMap): string {
  const apiKey = env.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("Missing E2B_API_KEY");
  }
  return apiKey;
}

async function loadRuntimeEnv(
  flags: ParsedFlags,
  role: SwarmRole,
  apiUrl?: string,
): Promise<EnvMap> {
  const envFiles = values(flags, "env-file").map((path) => absolutePath(path));
  const fileEnv: EnvMap = {};
  for (const env of await Promise.all(envFiles.map((path) => readDotenvFile(path)))) {
    Object.assign(fileEnv, env);
  }

  const inheritKeys = [...DEFAULT_E2B_FORWARD_KEYS, ...splitKeys(values(flags, "inherit-env"))];
  const inherited = selectEnv(process.env, inheritKeys);
  const runtime: EnvMap = { ...inherited, ...fileEnv };

  for (const raw of values(flags, "secret")) {
    const [key, secretValue] = parseKeyValue(raw, "--secret");
    runtime[key] = secretValue;
  }

  let swarmApiKey: string;
  try {
    swarmApiKey = resolveSwarmApiKey(runtime, value(flags, "api-key"));
  } catch (err) {
    if (!booleanFlag(flags, "dry-run")) throw err;
    swarmApiKey = "dry-run-api-key";
  }
  runtime.API_KEY = swarmApiKey;
  runtime.AGENT_SWARM_API_KEY = swarmApiKey;
  runtime.STARTUP_SCRIPT_STRICT = value(flags, "startup-script-strict", "false");

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
    runtime.AGENT_ROLE = value(flags, "agent-role", "worker");
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

function printHumanStart(result: StartedRole, env: EnvMap): void {
  console.log(`${result.role} sandbox: ${result.sandbox.sandboxID}`);
  if (result.url) console.log(`${result.role} url: ${result.url}`);
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
  role: SwarmRole,
  apiUrl?: string,
): Promise<StartedRole> {
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const runtimeEnv = await loadRuntimeEnv(flags, role, apiUrl);
  const controllerApiKey = e2bControllerApiKey(controllerEnv);
  const template = roleTemplate(flags, role);
  const timeoutSec = integerFlag(flags, "timeout-sec", 3600);
  const apiBase = value(flags, "e2b-api-base", DEFAULT_E2B_API_BASE);
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
    };
    return {
      role,
      sandbox: fakeSandbox,
      url: role === "api" ? sandboxPortUrl(fakeSandbox, port) : undefined,
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
      env: runtimeEnv,
      command: entrypoint,
      role,
      cwd: role === "api" ? "/app" : "/workspace",
    });

    const url = role === "api" ? sandboxPortUrl(sandbox, port) : undefined;
    if (role === "api" && !booleanFlag(flags, "no-wait")) {
      await waitForHttpOk(`${url}/health`, integerFlag(flags, "wait-ms", 90_000));
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
  const controllerEnv = await loadE2BControllerEnv(flags, cwd, { requireApiKey: false });

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
  const result = await startRole(flags, cwd, "api");
  const runtimeEnv = await loadRuntimeEnv(flags, "api");
  if (booleanFlag(flags, "json")) {
    console.log(JSON.stringify(publicStartedRole(result, runtimeEnv), null, 2));
  } else {
    printHumanStart(result, runtimeEnv);
  }
}

async function startWorkerCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const apiUrl = value(flags, "api-url");
  const result = await startRole(flags, cwd, "worker", apiUrl);
  const runtimeEnv = await loadRuntimeEnv(flags, "worker", apiUrl);
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
  const apiBase = value(flags, "e2b-api-base", DEFAULT_E2B_API_BASE);

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

async function startStackCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const started: StartedRole[] = [];
  const workers: StartedRole[] = [];

  try {
    const api = await startRole(flags, cwd, "api");
    started.push(api);
    if (!api.url) throw new Error("API sandbox did not produce a public URL");

    const workerCount = integerFlag(flags, "workers", 1);
    for (let i = 0; i < workerCount; i++) {
      const worker = await startRole(flags, cwd, "worker", api.url);
      workers.push(worker);
      started.push(worker);
    }
    const runtimeEnv = await loadRuntimeEnv(flags, "api");

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

async function killCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const ids = flags.positionals;
  if (ids.length === 0) throw new Error("kill requires at least one sandbox ID");
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const apiBase = value(flags, "e2b-api-base", DEFAULT_E2B_API_BASE);
  for (const id of ids) {
    await killSandbox(id, e2bControllerApiKey(controllerEnv), apiBase);
    console.log(`killed ${id}`);
  }
}

async function listCommand(flags: ParsedFlags, cwd: string): Promise<void> {
  const controllerEnv = await loadE2BControllerEnv(flags, cwd);
  const apiBase = value(flags, "e2b-api-base", DEFAULT_E2B_API_BASE);
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
  agent-swarm e2b kill <sandbox-id...>

Common options:
  --env-file <path>          Load runtime env/secrets for API or worker (repeatable)
  --secret KEY=VALUE         Add/override one runtime secret (repeatable)
  --inherit-env KEY[,KEY]    Forward extra local env vars into the sandbox
  --api-key <key>            Swarm API key passed to API/worker (required unless env provides one)
  --agent-id <id>            Worker agent ID (default: e2b-<sandbox-id>)
  --timeout-sec <seconds>    Sandbox TTL (default 3600)
  --e2b-api-key-file <path>  Read the E2B controller API key from a file
  --e2b-access-token-file <path>
                             Read E2B CLI access token for publish/unpublish
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
