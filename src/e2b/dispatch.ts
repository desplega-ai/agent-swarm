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
  // Client-side fallback for the sandbox expiry. The raw `POST /sandboxes`
  // create response uses E2B's `Sandbox` schema, which (unlike `ListedSandbox`
  // / `SandboxDetail`) does NOT include `endAt`. We populate this from
  // `now + timeoutSec*1000` at create time so `ttlRemaining` can report expiry
  // immediately after a launch without an extra round-trip. `endAt` (when
  // present, e.g. from `listSandboxes`) is always authoritative over this.
  expiresAt?: string;
};

export type TtlRemaining = {
  expiresAt?: string;
  secondsLeft?: number;
};

export type SetSandboxTimeoutOptions = {
  sandboxId: string;
  apiKey: string;
  apiBase?: string;
  e2bEnv?: EnvMap;
  timeoutMs: number;
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

export type StreamSandboxLogOptions = {
  sandboxId: string;
  role: E2BRole;
  apiKey: string;
  apiBase?: string;
  e2bEnv?: EnvMap;
  /** Number of trailing history lines to emit before following (default 200). */
  tailLines?: number;
  /** When true, keep streaming new output (`tail -f`) until the caller aborts. */
  follow?: boolean;
  /**
   * Egress sink for each chunk. The caller MUST scrub here — log output is
   * untrusted entrypoint stdout and can embed tokens/secrets.
   */
  onChunk: (chunk: string) => void;
  /** Abort signal to stop a `--follow` stream (e.g. on SIGINT). */
  signal?: AbortSignal;
};

type E2BSdkConnectionOptions = {
  apiKey: string;
  apiUrl?: string;
  domain?: string;
  sandboxUrl?: string;
};

type E2BTemplateVisibilityResponse = {
  names: string[];
};

function e2bHeaders(apiKey: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    "X-API-Key": apiKey,
  };
}

/**
 * Build the shell payload for the envd-tracked entrypoint launch. Phase 5: the
 * entrypoint is no longer detached via `nohup … >file &` (a grandchild envd
 * never sees). Instead it runs as the SDK background command itself (envd owns
 * and streams it; it survives client disconnect). We still `tee` to a
 * deterministic file so `swarms logs` can retrieve FULL history later: the SDK's
 * `commands.connect(pid)` only streams output going forward from the connect
 * instant — it does NOT replay stdout produced while disconnected (verified
 * against the e2b SDK types + docs) — so the file copy is the only reliable
 * full-history source.
 *
 * `set -o pipefail` makes the pipeline's exit code reflect the ENTRYPOINT rather
 * than `tee` (tee exits 0 on EOF even if the entrypoint crashed), so the early
 * `exitCode` poll in {@link startDetachedProcess} can detect a launch failure.
 * Invoked via `bash -lc` (both the api + worker images ship bash) for pipefail.
 */
export function buildTrackedShell(command: string, logPath: string): string {
  return `set -o pipefail; ${command} 2>&1 | tee ${logPath}`;
}

export function e2bSdkConnectionOptions(
  apiKey: string,
  env: EnvMap,
  apiBase?: string,
): E2BSdkConnectionOptions {
  const options: E2BSdkConnectionOptions = { apiKey };
  const resolvedApiUrl = apiBase || env.E2B_API_URL;
  if (resolvedApiUrl) options.apiUrl = resolvedApiUrl;
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
  // Capture the wall-clock create instant BEFORE the request so the client-side
  // expiry fallback reflects when the TTL countdown begins.
  const createdAt = Date.now();
  const sandbox = await e2bFetchJson<E2BSandboxInfo>(
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
  // Pre-flight check (resolved against node_modules/e2b types): the create
  // response is E2B's `Sandbox` schema, which omits `endAt`. Compute a
  // client-side expiry fallback so `ttlRemaining` works right after launch.
  if (!sandbox.endAt && !sandbox.expiresAt) {
    sandbox.expiresAt = new Date(createdAt + opts.timeoutSec * 1000).toISOString();
  }
  return sandbox;
}

/**
 * Compute the remaining time-to-live for a sandbox. Prefers the authoritative
 * `endAt` (present on listed/detail responses); falls back to the client-side
 * `expiresAt` stamped by `createSandbox`. Returns an empty object when neither
 * is available (e.g. a dry-run fake sandbox). `secondsLeft` is clamped at 0 so
 * an already-expired sandbox never reports negative time.
 */
export function ttlRemaining(sandbox: E2BSandboxInfo): TtlRemaining {
  const expiresAt = sandbox.endAt ?? sandbox.expiresAt;
  if (!expiresAt) return {};
  const expiryMs = Date.parse(expiresAt);
  if (Number.isNaN(expiryMs)) return {};
  const secondsLeft = Math.max(0, Math.round((expiryMs - Date.now()) / 1000));
  return { expiresAt, secondsLeft };
}

/**
 * Extend (or reduce) a live sandbox's TTL via the SDK and read back the actual
 * `endAt` E2B applied (the server clamps to the tier max, so the requested
 * timeout is not always honored verbatim). Connecting to a dead/expired sandbox
 * throws; we translate that into a redacted "not found / already expired"
 * error so a stale sandbox ID never leaks the controller key into logs.
 */
export async function setSandboxTimeout(opts: SetSandboxTimeoutOptions): Promise<TtlRemaining> {
  const { Sandbox } = await import("e2b");
  let sandbox: Awaited<ReturnType<typeof Sandbox.connect>>;
  try {
    sandbox = await Sandbox.connect(
      opts.sandboxId,
      e2bSdkConnectionOptions(opts.apiKey, opts.e2bEnv ?? {}, opts.apiBase),
    );
  } catch {
    // Do not surface the underlying error verbatim — it can embed the
    // controller API key / connection URL. Emit a fixed redacted message.
    throw new Error(`sandbox ${opts.sandboxId} not found / already expired`);
  }

  await sandbox.setTimeout(opts.timeoutMs);
  // `setTimeout` returns void; re-read the info to learn the clamped expiry.
  const info = await sandbox.getInfo();
  const expiresAt = info.endAt instanceof Date ? info.endAt.toISOString() : String(info.endAt);
  return ttlRemaining({
    sandboxID: opts.sandboxId,
    templateID: info.templateId,
    endAt: expiresAt,
  });
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

/**
 * The deterministic per-role log path the entrypoint tees to. `swarms logs`
 * recomputes it from the role alone (no PID bookkeeping needed) to `tail`/`cat`
 * full history or `tail -f` for `--follow`.
 */
export function sandboxLogPath(role: E2BRole): string {
  return `/tmp/agent-swarm-e2b-${role}.log`;
}

/**
 * Launch the entrypoint as an envd-tracked BACKGROUND command (Phase 5). Returns
 * the PID immediately. Replaces the old `nohup … >file & sleep 2; kill -0` hack:
 * the SDK's background handle exposes `exitCode` (undefined while running), so we
 * poll it once after a short grace period — a non-zero exit by then means the
 * entrypoint died at launch, which we surface as a launch failure (reading the
 * tee'd log for context). The `tee` preserves a file copy for full-history
 * retrieval regardless of envd stdout-replay semantics.
 */
export async function startDetachedProcess(opts: StartDetachedOptions): Promise<string> {
  const logPath = sandboxLogPath(opts.role);
  const shell = buildTrackedShell(opts.command, logPath);

  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.connect(
    opts.sandbox.sandboxID,
    e2bSdkConnectionOptions(opts.apiKey, opts.e2bEnv ?? {}, opts.apiBase),
  );
  // `bash -lc` (not `sh`) so `set -o pipefail` is honored on both images.
  const handle = await sandbox.commands.run(`bash -lc ${shellQuote(shell)}`, {
    user: opts.user ?? "root",
    cwd: opts.cwd ?? "/",
    envs: opts.env,
    background: true,
  });

  // Early liveness poll: give the entrypoint a moment to fault, then check the
  // handle's exit code. `undefined` = still running (the expected happy path).
  await Bun.sleep(2_000);
  if (typeof handle.exitCode === "number" && handle.exitCode !== 0) {
    // The pipeline already exited non-zero — surface stderr/stdout (redacted, as
    // entrypoint output can embed tokens) as a launch failure.
    const detail = redactWithEnv(`${handle.stdout}\n${handle.stderr}`.trim(), opts.env);
    throw new Error(`E2B start command exited ${handle.exitCode} at launch: ${detail}`);
  }

  return String(handle.pid);
}

/** Single-quote a string for safe embedding in a `bash -lc '<...>'` invocation. */
function shellQuote(value: string): string {
  return `'${value.split("'").join(`'\\''`)}'`;
}

/**
 * Stream a sandbox's tee'd entrypoint log to the caller's `onChunk` sink.
 *
 * Design (Phase 5): we read from the deterministic per-role {@link sandboxLogPath}
 * the entrypoint tees to — NOT from a tracked PID — so no PID bookkeeping is
 * needed and history survives reconnect / a fresh CLI process. The SDK's
 * `commands.connect(pid)` only streams forward from connect (no historical
 * replay, verified against the SDK), so the file is the source of truth for
 * full history.
 *
 * - History (no `--follow`): `tail -n <N> <logPath>` once (a CommandResult).
 * - Follow: `tail -n <N> -F <logPath>` as a BACKGROUND command, piping each
 *   `onStdout`/`onStderr` chunk to `onChunk` until the abort signal fires
 *   (`-F` keeps following across truncation/rotation; tolerates a not-yet-created
 *   file). The caller scrubs inside `onChunk`.
 *
 * Output is emitted RAW here; the caller is responsible for scrubbing in
 * `onChunk` (it sees both this function's stdout and stderr).
 */
export async function streamSandboxLog(opts: StreamSandboxLogOptions): Promise<void> {
  const logPath = sandboxLogPath(opts.role);
  const tailLines = opts.tailLines ?? 200;

  const { Sandbox } = await import("e2b");
  const sandbox = await Sandbox.connect(
    opts.sandboxId,
    e2bSdkConnectionOptions(opts.apiKey, opts.e2bEnv ?? {}, opts.apiBase),
  );

  if (!opts.follow) {
    // History only: a single `tail`. If the file does not exist yet (entrypoint
    // hasn't written), `tail` exits non-zero with a message on stderr — we emit
    // that to the sink rather than throwing, so a freshly-launched swarm reads as
    // "no logs yet" instead of a hard error.
    const result = await sandbox.commands.run(
      `bash -lc ${shellQuote(`tail -n ${tailLines} ${logPath} 2>&1 || true`)}`,
      { user: "root", timeoutMs: 30_000 },
    );
    if (result.stdout) opts.onChunk(result.stdout);
    if (result.stderr) opts.onChunk(result.stderr);
    return;
  }

  // Follow: background `tail -F` streaming forward. `-F` (vs `-f`) re-opens the
  // file if it is rotated/recreated and waits for a not-yet-existing file.
  const handle = await sandbox.commands.run(
    `bash -lc ${shellQuote(`tail -n ${tailLines} -F ${logPath}`)}`,
    {
      user: "root",
      background: true,
      onStdout: (data) => opts.onChunk(data),
      onStderr: (data) => opts.onChunk(data),
    },
  );

  const stop = async () => {
    try {
      await handle.kill();
    } catch {
      // The command may already be gone (sandbox killed/expired); ignore.
    }
  };
  if (opts.signal) {
    if (opts.signal.aborted) {
      await stop();
      return;
    }
    opts.signal.addEventListener("abort", stop, { once: true });
  }

  try {
    // `wait()` resolves when the stream ends (sandbox death) or the handle is
    // killed by the abort listener above. `tail -F` otherwise runs indefinitely.
    await handle.wait();
  } catch {
    // A kill / disconnect surfaces as a rejected wait — that is the expected exit
    // path for `--follow`, not an error to propagate.
  }
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
  const path = `/v2/templates/${encodeURIComponent(opts.name)}`;
  if (opts.dryRun) {
    return {
      exitCode: 0,
      stdout: `PATCH ${path} {"public":${opts.public}}\n`,
      stderr: "",
    };
  }

  const apiKey = opts.e2bEnv.E2B_API_KEY;
  if (!apiKey) {
    throw new Error("Missing E2B_API_KEY");
  }

  const result = await e2bFetchJson<E2BTemplateVisibilityResponse>(
    path,
    apiKey,
    {
      method: "PATCH",
      body: JSON.stringify({ public: opts.public }),
    },
    opts.e2bEnv.E2B_API_URL || DEFAULT_E2B_API_BASE,
  );
  const names = result.names.length > 0 ? ` (${result.names.join(", ")})` : "";
  const visibility = opts.public ? "public" : "private";
  return {
    exitCode: 0,
    stdout: `Set E2B template ${opts.name} visibility to ${visibility}${names}\n`,
    stderr: "",
  };
}
