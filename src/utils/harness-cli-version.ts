/**
 * The worker's harness CLI version (`claude --version` / `codex --version`),
 * reported on register and used to key harness_model_support rows. Worker-safe
 * (no DB). Probed once per process; null when the CLI is missing or silent.
 */
import { isUnknownModelError } from "./harness-model-error";
import { scrubSecrets } from "./secret-scrubber";

const CLI_BINARY: Record<string, string> = { claude: "claude", codex: "codex" };
const PROBE_TIMEOUT_MS = 10_000;
const VERSION_RE = /\d+\.\d+\.\d+(?:[-+][\w.]+)?/;

const probed = new Map<string, Promise<string | null>>();

export function parseCliVersion(output: string): string | null {
  return VERSION_RE.exec(output)?.[0] ?? null;
}

export function probeHarnessCliVersion(harness: string): Promise<string | null> {
  const binary = CLI_BINARY[harness];
  if (!binary) return Promise.resolve(null);
  let pending = probed.get(harness);
  if (!pending) {
    pending = (async () => {
      try {
        const proc = Bun.spawn([binary, "--version"], {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          timeout: PROBE_TIMEOUT_MS,
          killSignal: "SIGKILL",
        });
        const [stdout, exitCode] = await Promise.all([
          new Response(proc.stdout).text(),
          proc.exited,
        ]);
        return exitCode === 0 ? parseCliVersion(stdout) : null;
      } catch {
        return null;
      }
    })();
    probed.set(harness, pending);
  }
  return pending;
}

/** Last probed version, without waiting; null until the probe finished. */
export async function cachedHarnessCliVersion(harness: string): Promise<string | null> {
  return (await probed.get(harness)) ?? null;
}

const reported = new Set<string>();

/**
 * Record a model's run outcome on this worker's CLI. `ok` is sent once per
 * model per process; `unsupported` whenever the CLI rejects the id. Other
 * failures say nothing about support and are not sent. Never throws.
 */
export async function reportHarnessModelOutcome(opts: {
  apiUrl: string;
  apiKey?: string;
  agentId: string;
  harness: string;
  model: string | undefined;
  exitCode: number;
  failureReason?: string;
  fetchImpl?: typeof fetch;
}): Promise<void> {
  if (!opts.model || !CLI_BINARY[opts.harness]) return;
  const cliVersion = await cachedHarnessCliVersion(opts.harness);
  if (!cliVersion) return;
  const status =
    opts.exitCode === 0 ? "ok" : isUnknownModelError(opts.failureReason) ? "unsupported" : null;
  if (!status) return;
  const key = `${opts.harness}|${cliVersion}|${opts.model}`;
  if (status === "ok" && reported.has(key)) return;
  try {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Agent-ID": opts.agentId,
    };
    if (opts.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
    const res = await (opts.fetchImpl ?? fetch)(
      `${opts.apiUrl}/api/models-catalog/harness-support`,
      {
        method: "PUT",
        headers,
        body: JSON.stringify({
          harness: opts.harness,
          cliVersion,
          modelId: opts.model,
          status,
          ...(status === "unsupported" && opts.failureReason
            ? { error: scrubSecrets(opts.failureReason).slice(0, 2000) }
            : {}),
        }),
      },
    );
    if (res.ok && status === "ok") reported.add(key);
  } catch {
    // Best effort: the next run reports again.
  }
}

export function resetHarnessCliVersionForTests(seed?: Record<string, string | null>): void {
  probed.clear();
  reported.clear();
  for (const [harness, version] of Object.entries(seed ?? {})) {
    probed.set(harness, Promise.resolve(version));
  }
}
