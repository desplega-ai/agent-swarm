import { buildWorkflowCtx } from "./workflow-ctx";

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env ${name}`);
  return value;
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
const apiKey = requiredEnv("AGENT_SWARM_API_KEY");
const baseUrl = requiredEnv("MCP_BASE_URL").replace(/\/$/, "");
const sourceFile = requiredEnv("SCRIPT_RUN_SOURCE_FILE");
const argsFile = requiredEnv("SCRIPT_RUN_ARGS_FILE");
const userModulePath = `${requiredEnv("SCRIPT_RUN_TMPDIR")}/user-script.ts`;

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

try {
  const source = await Bun.file(sourceFile).text();
  const args = JSON.parse(await Bun.file(argsFile).text());
  await Bun.write(userModulePath, source);
  const mod = await import(userModulePath);
  if (typeof mod.default !== "function") {
    throw new Error("Script workflow must export a default function");
  }
  const ctx = buildWorkflowCtx({ runId, agentId, apiKey, baseUrl, args });
  const output = await mod.default(args, ctx);
  await postStatus(runId, baseUrl, agentId, apiKey, {
    status: "completed",
    output: output ?? null,
  });
  process.exit(0);
} catch (err) {
  console.error(err instanceof Error ? err.stack || err.message : String(err));
  await postStatus(runId, baseUrl, agentId, apiKey, {
    status: "failed",
    error: err instanceof Error ? err.message : String(err),
  });
  process.exit(1);
} finally {
  clearInterval(heartbeat);
}
