import { DEFAULT_E2B_API_BASE, type EnvMap, redactWithEnv } from "./env";

export type E2BRole = "api" | "worker";

export type E2BSandboxInfo = {
  templateID: string;
  sandboxID: string;
  clientID?: string;
  envdVersion?: string;
  alias?: string;
  envdAccessToken?: string;
  trafficAccessToken?: string;
  domain?: string | null;
  startedAt?: string;
  endAt?: string;
  metadata?: Record<string, string>;
};

export type E2BCommandResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

export type BuildTemplateOptions = {
  role: E2BRole;
  name: string;
  dockerfile: string;
  cwd: string;
  cpuCount: number;
  memoryMb: number;
  noCache: boolean;
  e2bEnv: EnvMap;
  dryRun?: boolean;
};

export type DeleteTemplateOptions = {
  name: string;
  e2bEnv: EnvMap;
  dryRun?: boolean;
};

export type TemplateVisibilityOptions = {
  name: string;
  e2bEnv: EnvMap;
  public: boolean;
  dryRun?: boolean;
};

export type BuildImageTemplateOptions = {
  role: E2BRole;
  name: string;
  image: string;
  cpuCount: number;
  memoryMb: number;
  noCache: boolean;
  e2bEnv: EnvMap;
  dryRun?: boolean;
};

export type CreateSandboxOptions = {
  apiKey: string;
  apiBase?: string;
  template: string;
  timeoutSec: number;
  envVars: EnvMap;
  metadata: Record<string, string>;
  allowInternetAccess?: boolean;
};

export type StartDetachedOptions = {
  sandbox: E2BSandboxInfo;
  apiKey: string;
  apiBase?: string;
  e2bEnv?: EnvMap;
  env: EnvMap;
  command: string;
  role: E2BRole;
  user?: string;
  cwd?: string;
};

type E2BSdkConnectionOptions = {
  apiKey: string;
  apiUrl?: string;
  accessToken?: string;
  domain?: string;
  sandboxUrl?: string;
};

function e2bHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };
}

export function buildDetachedShell(command: string, logPath: string, pidPath: string): string {
  return [
    "set -e",
    `nohup ${command} >${logPath} 2>&1 </dev/null & pid=$!`,
    "sleep 2",
    `if ! kill -0 "$pid" 2>/dev/null; then cat ${logPath} >&2; exit 1; fi`,
    `echo "$pid" > ${pidPath}`,
    'echo "$pid"',
  ].join("; ");
}

export function e2bSdkConnectionOptions(
  apiKey: string,
  env: EnvMap,
  apiBase?: string,
): E2BSdkConnectionOptions {
  const options: E2BSdkConnectionOptions = { apiKey };
  const resolvedApiUrl = apiBase || env.E2B_API_URL;
  if (resolvedApiUrl) options.apiUrl = resolvedApiUrl;
  if (env.E2B_ACCESS_TOKEN) options.accessToken = env.E2B_ACCESS_TOKEN;
  if (env.E2B_DOMAIN) options.domain = env.E2B_DOMAIN;
  if (env.E2B_SANDBOX_URL) options.sandboxUrl = env.E2B_SANDBOX_URL;
  return options;
}

function sandboxDomainFromUrl(rawUrl: string): string | undefined {
  try {
    const url = new URL(rawUrl);
    const host = url.host;
    return host.startsWith("sandbox.") ? host.slice("sandbox.".length) : host;
  } catch {
    const host = rawUrl.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
    if (!host) return undefined;
    return host.startsWith("sandbox.") ? host.slice("sandbox.".length) : host;
  }
}

function configuredSandboxDomain(env: EnvMap): string | undefined {
  if (env.E2B_DOMAIN) return env.E2B_DOMAIN;
  if (env.E2B_SANDBOX_URL) return sandboxDomainFromUrl(env.E2B_SANDBOX_URL);
  return undefined;
}

export function sandboxPortHost(sandbox: E2BSandboxInfo, port: number, env: EnvMap = {}): string {
  const domain = sandbox.domain || configuredSandboxDomain(env) || "e2b.app";
  if (domain.includes(sandbox.sandboxID)) {
    return `${port}-${domain}`;
  }
  return `${port}-${sandbox.sandboxID}.${domain}`;
}

export function sandboxPortUrl(sandbox: E2BSandboxInfo, port: number, env: EnvMap = {}): string {
  return `https://${sandboxPortHost(sandbox, port, env)}`;
}

async function readResponseBody(response: Response): Promise<string> {
  const text = await response.text();
  return text.trim();
}

export async function e2bFetchJson<T>(
  path: string,
  apiKey: string,
  init: RequestInit = {},
  apiBase = DEFAULT_E2B_API_BASE,
): Promise<T> {
  const response = await fetch(`${apiBase}${path}`, {
    ...init,
    headers: {
      ...e2bHeaders(apiKey),
      ...(init.headers ?? {}),
    },
  });

  if (!response.ok) {
    const body = await readResponseBody(response);
    throw new Error(`E2B API ${response.status} ${response.statusText}: ${body}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export async function createSandbox(opts: CreateSandboxOptions): Promise<E2BSandboxInfo> {
  return e2bFetchJson<E2BSandboxInfo>(
    "/sandboxes",
    opts.apiKey,
    {
      method: "POST",
      body: JSON.stringify({
        templateID: opts.template,
        timeout: opts.timeoutSec,
        secure: true,
        allow_internet_access: opts.allowInternetAccess ?? true,
        metadata: opts.metadata,
        envVars: opts.envVars,
      }),
    },
    opts.apiBase,
  );
}

export async function killSandbox(
  sandboxId: string,
  apiKey: string,
  apiBase = DEFAULT_E2B_API_BASE,
): Promise<void> {
  await e2bFetchJson<void>(
    `/sandboxes/${encodeURIComponent(sandboxId)}`,
    apiKey,
    { method: "DELETE" },
    apiBase,
  );
}

export async function listSandboxes(
  apiKey: string,
  apiBase = DEFAULT_E2B_API_BASE,
): Promise<E2BSandboxInfo[]> {
  return e2bFetchJson<E2BSandboxInfo[]>("/sandboxes", apiKey, {}, apiBase);
}

export async function startDetachedProcess(opts: StartDetachedOptions): Promise<string> {
  const logPath = `/tmp/agent-swarm-e2b-${opts.role}.log`;
  const pidPath = `/tmp/agent-swarm-e2b-${opts.role}.pid`;
  const shell = buildDetachedShell(opts.command, logPath, pidPath);

  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.connect(
    opts.sandbox.sandboxID,
    e2bSdkConnectionOptions(opts.apiKey, opts.e2bEnv ?? {}, opts.apiBase),
  );
  const result = await sandbox.commands.run(shell, {
    user: opts.user ?? "root",
    cwd: opts.cwd ?? "/",
    envs: opts.env,
    timeoutMs: 30_000,
  });

  if (result.exitCode !== 0) {
    throw new Error(`E2B start command failed: ${redactWithEnv(result.stderr, opts.env)}`);
  }
  return result.stdout.trim();
}

export async function waitForAgentRegistration(
  apiUrl: string,
  agentId: string,
  apiKey: string,
  timeoutMs: number,
): Promise<void> {
  const baseUrl = apiUrl.replace(/\/+$/, "");
  const url = `${baseUrl}/api/agents/${encodeURIComponent(agentId)}`;
  const started = Date.now();
  let lastError = "";

  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${apiKey}`,
        },
      });
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(1_000);
  }

  throw new Error(
    `Timed out waiting for worker ${agentId} to register at ${url}${
      lastError ? ` (${lastError})` : ""
    }`,
  );
}

export async function waitForHttpOk(url: string, timeoutMs: number): Promise<void> {
  const started = Date.now();
  let lastError = "";
  while (Date.now() - started < timeoutMs) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
      lastError = `${response.status} ${response.statusText}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await Bun.sleep(1_000);
  }
  throw new Error(`Timed out waiting for ${url}${lastError ? ` (${lastError})` : ""}`);
}

export function buildTemplateArgs(opts: BuildTemplateOptions): string[] {
  const args = [
    "template",
    "create",
    "-p",
    opts.cwd,
    "-d",
    opts.dockerfile,
    "-c",
    "sleep infinity",
    "--ready-cmd",
    "sleep 0",
    "--cpu-count",
    String(opts.cpuCount),
    "--memory-mb",
    String(opts.memoryMb),
  ];

  if (opts.noCache) {
    args.push("--no-cache");
  }

  args.push(opts.name);
  return args;
}

export async function runE2BCommand(args: string[], env: EnvMap): Promise<E2BCommandResult> {
  const child = Bun.spawn(["e2b", ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { stdout: redactWithEnv(stdout, env), stderr: redactWithEnv(stderr, env), exitCode };
}

export async function buildTemplate(opts: BuildTemplateOptions): Promise<E2BCommandResult> {
  const args = buildTemplateArgs(opts);
  if (opts.dryRun) {
    return { exitCode: 0, stdout: `e2b ${args.join(" ")}\n`, stderr: "" };
  }
  return runE2BCommand(args, opts.e2bEnv);
}

export async function buildImageTemplate(
  opts: BuildImageTemplateOptions,
): Promise<E2BCommandResult> {
  if (opts.dryRun) {
    return {
      exitCode: 0,
      stdout: [
        `e2b-sdk template build --from-image ${opts.image}`,
        `  --name ${opts.name}`,
        `  --start-cmd "sleep infinity"`,
        `  --ready-cmd "sleep 0"`,
        `  --cpu-count ${opts.cpuCount}`,
        `  --memory-mb ${opts.memoryMb}`,
        opts.noCache ? `  --no-cache` : "",
      ]
        .filter(Boolean)
        .join("\n")
        .concat("\n"),
      stderr: "",
    };
  }

  const apiKey = opts.e2bEnv.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("Missing E2B_API_KEY");
  }

  const { Template } = await import("e2b");
  const template = Template().fromImage(opts.image).setStartCmd("sleep infinity", "sleep 0");
  const buildInfo = await Template.build(template, opts.name, {
    ...e2bSdkConnectionOptions(apiKey, opts.e2bEnv),
    cpuCount: opts.cpuCount,
    memoryMB: opts.memoryMb,
    skipCache: opts.noCache,
  });

  return {
    exitCode: 0,
    stdout: `Built E2B ${opts.role} template ${buildInfo.name} (${buildInfo.templateId}, build ${buildInfo.buildId})\n`,
    stderr: "",
  };
}

export async function deleteTemplate(opts: DeleteTemplateOptions): Promise<E2BCommandResult> {
  const args = ["template", "delete", opts.name, "-y"];
  if (opts.dryRun) {
    return { exitCode: 0, stdout: `e2b ${args.join(" ")}\n`, stderr: "" };
  }
  return runE2BCommand(args, opts.e2bEnv);
}

export async function setTemplateVisibility(
  opts: TemplateVisibilityOptions,
): Promise<E2BCommandResult> {
  const action = opts.public ? "publish" : "unpublish";
  const args = ["template", action, opts.name, "-y"];
  if (opts.dryRun) {
    return { exitCode: 0, stdout: `e2b ${args.join(" ")}\n`, stderr: "" };
  }
  return runE2BCommand(args, opts.e2bEnv);
}
