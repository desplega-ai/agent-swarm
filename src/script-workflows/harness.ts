import { buildWorkflowCtx } from "./workflow-ctx";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
}

/**
 * The bearer travels over stdin, not an env var (see executor.ts) — this
 * process dynamically `import()`s the user's module into itself below, so
 * anything left in `process.env` would be directly readable by
 * attacker-influenced script content via a bracket-notation env lookup.
 */
async function readApiKeyFromStdin(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Malformed stdin config payload (expected JSON)");
  }
  const apiKey = (parsed as { apiKey?: unknown } | null)?.apiKey;
  if (typeof apiKey !== "string" || !apiKey) {
    throw new Error("Missing apiKey on stdin config payload");
  }
  return apiKey;
}

async function postStatus(
  runId: string,
  baseUrl: string,
  agentId: string,
  apiKey: string,
  body: Record<string, unknown>,
): Promise<void> {
  const res = await fetch(`${baseUrl}/api/internal/script-runs/${runId}/status`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(`status callback failed with ${res.status}: ${await res.text()}`);
  }
}

const runId = requiredEnv("SCRIPT_RUN_ID");
const agentId = requiredEnv("SCRIPT_RUN_AGENT_ID");
const apiKey = await readApiKeyFromStdin();
const baseUrl = requiredEnv("MCP_BASE_URL").replace(/\/$/, "");
const sourceFile = requiredEnv("SCRIPT_RUN_SOURCE_FILE");
const argsFile = requiredEnv("SCRIPT_RUN_ARGS_FILE");
// Subdirectory, not the tmpdir itself: the executor spawns this harness with
// cwd = tmpdir, and Bun (>= 1.3.12) snapshots the cwd listing at startup — a
// file written into cwd after launch is invisible to the module resolver. See
// the same fix in src/scripts-runtime/eval-harness.ts.
const userModulePath = `${requiredEnv("SCRIPT_RUN_TMPDIR")}/user-module/user-script.ts`;

const heartbeat = setInterval(() => {
  fetch(`${baseUrl}/api/internal/script-runs/${runId}/heartbeat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "X-Agent-ID": agentId,
    },
  }).catch(() => {});
}, 10_000);
heartbeat.unref?.();

let drainInFlightSteps: ((graceMs?: number) => Promise<void>) | undefined;

try {
  const source = await Bun.file(sourceFile).text();
  const args = JSON.parse(await Bun.file(argsFile).text());
  await Bun.write(userModulePath, source);
  const mod = await import(userModulePath);
  if (typeof mod.default !== "function") {
    throw new Error("Script workflow must export a default function");
  }
  const built = buildWorkflowCtx({ runId, agentId, apiKey, baseUrl, args });
  drainInFlightSteps = built.drainInFlightSteps;
  const output = await mod.default(args, built.ctx);
  await postStatus(runId, baseUrl, agentId, apiKey, {
    status: "completed",
    output: output ?? null,
  });
  process.exit(0);
} catch (err) {
  // A rejection here can happen while Promise.all siblings of the failing
  // step are still in flight (Promise.all rejects as soon as ANY member
  // does, without waiting for the rest). Give them a bounded chance to
  // finish their own journal write before this process exits — otherwise
  // their work is silently orphaned even though the underlying agent task
  // may have already completed server-side.
  await drainInFlightSteps?.().catch(() => {});
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  await postStatus(runId, baseUrl, agentId, apiKey, {
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
} finally {
  clearInterval(heartbeat);
}
