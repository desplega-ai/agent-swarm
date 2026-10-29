#!/usr/bin/env bun
/**
 * Smoke test for on-demand worker runtimes.
 *
 * Plays the part of the future API-side supervisor by hand:
 *   1. create a task pinned to a brand-new agent id (no agent row, no runtime)
 *   2. provision a runtime for that agent through a RuntimeProvider
 *   3. measure: infra accepted -> worker registered -> task started -> task done
 *   4. terminate the runtime and confirm list() no longer reports it
 *
 * The worker boots from the stock image/template and polls as today. Delivery
 * stays pull: this smoke test exercises provisioning.
 *
 * Usage:
 *   bun scripts/runtime-provider-smoke.ts --provider docker \
 *     --api http://localhost:3913 --worker-api http://host.docker.internal:3913 \
 *     --image ghcr.io/desplega-ai/agent-swarm-worker:slim
 *   bun scripts/runtime-provider-smoke.ts --provider e2b \
 *     --api http://localhost:3913 --worker-api https://<ngrok-host> \
 *     --image agent-swarm-worker-1-168-0
 *   BOXD_API_KEY=bxd_... bun scripts/runtime-provider-smoke.ts --provider boxd \
 *     --api http://localhost:3913 --worker-api https://<public-api-host> \
 *     --image ghcr.io/desplega-ai/agent-swarm-worker:slim
 */
import { parseArgs } from "node:util";
import { createRuntimeProvider, type RuntimeProviderKind } from "../src/runtime-providers";
import { getApiKey } from "../src/utils/api-key";
import { registerVolatileSecret, scrubSecrets } from "../src/utils/secret-scrubber";

const { values: args } = parseArgs({
  options: {
    provider: { type: "string" },
    api: { type: "string", default: "http://localhost:3913" },
    "worker-api": { type: "string" },
    image: { type: "string" },
    "api-key": { type: "string" },
    "owner-id": { type: "string" },
    "timeout-sec": { type: "string", default: "600" },
    keep: { type: "boolean", default: false },
  },
});

const kind = args.provider as RuntimeProviderKind;
if (!kind || !args.image || !args["worker-api"]) {
  console.error("required: --provider docker|e2b|boxd --image <image|template> --worker-api <url>");
  process.exit(2);
}
const apiKey = args["api-key"] ?? getApiKey();
if (!apiKey) throw new Error("Missing API key. Use --api-key or AGENT_SWARM_API_KEY.");
registerVolatileSecret(apiKey, "AGENT_SWARM_API_KEY");
const headers = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };

async function e2bKeyFromCli(): Promise<string | undefined> {
  const file = Bun.file(`${process.env.HOME}/.e2b/config.json`);
  if (!(await file.exists())) return undefined;
  return ((await file.json()) as { teamApiKey?: string }).teamApiKey;
}

const target: Record<string, string | undefined> =
  kind === "docker"
    ? {
        DOCKER_HOST: process.env.DOCKER_HOST ?? "unix:///var/run/docker.sock",
        DOCKER_NETWORK: process.env.DOCKER_NETWORK,
        DOCKER_EXTRA_HOSTS: process.env.DOCKER_EXTRA_HOSTS,
      }
    : kind === "boxd"
      ? {
          BOXD_API_KEY: process.env.BOXD_API_KEY,
          BOXD_ORG: process.env.BOXD_ORG,
          BOXD_BASE_URL: process.env.BOXD_BASE_URL,
          BOXD_SNAPSHOT: process.env.BOXD_SNAPSHOT,
          WORKER_API_URL: args["worker-api"],
        }
      : {
          E2B_API_KEY: process.env.E2B_API_KEY ?? (await e2bKeyFromCli()),
          E2B_API_BASE: process.env.E2B_API_BASE,
          E2B_MAX_CONTINUOUS_SEC: process.env.E2B_MAX_CONTINUOUS_SEC,
          WORKER_API_URL: args["worker-api"],
        };

async function api<T>(method: string, path: string, body?: unknown): Promise<T | undefined> {
  const res = await fetch(`${args.api}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 404) return undefined;
  if (!res.ok)
    throw new Error(scrubSecrets(`${method} ${path} -> ${res.status} ${await res.text()}`));
  return (await res.json()) as T;
}

const provider = await createRuntimeProvider(kind, target);
const config = provider.checkConfig(target);
if (!config.ready) {
  console.error(`provider ${kind} not ready: missing ${config.missing.join(", ")}`);
  process.exit(2);
}

const agentId = crypto.randomUUID();
const runtimeId = crypto.randomUUID();
const ownerId = args["owner-id"] ?? crypto.randomUUID();
const t0 = performance.now();
const marks: Record<string, number> = {};
const mark = (name: string) => {
  marks[name] = Math.round(performance.now() - t0);
  console.log(`[smoke] +${(marks[name] / 1000).toFixed(1)}s ${name}`);
};

// 1. Work exists for an agent that has no runtime (and no agent row yet).
const task = await api<{ id: string }>("POST", "/api/tasks", {
  task: "Smoke check: call store-progress to complete this task with the output 'pong'. Do nothing else.",
  agentId,
  routingReason: "human_pinned",
  modelTier: "smol",
});
if (!task) throw new Error("task create returned 404");
mark("task_created");

// 2. Wake: provision a runtime for the agent.
const handle = await provider.provision(target, {
  runtimeId,
  agentId,
  poolId: "smoke",
  ownerId,
  image: args.image,
  ttlSec: 1200,
  labels: { "swarm.smoke": "runtime-providers" },
  env: {
    AGENT_ID: agentId,
    AGENT_ROLE: "worker",
    API_KEY: apiKey,
    AGENT_SWARM_API_KEY: apiKey,
    MCP_BASE_URL: args["worker-api"],
    HARNESS_PROVIDER: "claude",
    CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN ?? "",
    MAX_CONCURRENT_TASKS: "1",
    YOLO: "true",
  },
});
mark("infra_accepted");
console.log(`[smoke] handle ${handle.kind}:${handle.externalId.slice(0, 16)}`);

// 3. Watch the API for registration, start and completion.
const deadline = Date.now() + Number(args["timeout-sec"]) * 1000;
let finalStatus = "timeout";
let leftoversAfterTerminate = 0;
try {
  while (Date.now() < deadline) {
    if (marks.worker_registered === undefined) {
      const agent = await api<{ id: string }>("GET", `/api/agents/${agentId}`);
      if (agent) mark("worker_registered");
    }
    const t = await api<{ status: string }>("GET", `/api/tasks/${task.id}`);
    if (t && marks.task_started === undefined && t.status !== "pending") mark("task_started");
    if (t && ["completed", "failed", "cancelled"].includes(t.status)) {
      finalStatus = t.status;
      mark("task_done");
      break;
    }
    if (marks.worker_registered === undefined) {
      const status = await provider.status(target, handle);
      if (status === "failed" || status === "exited") {
        finalStatus = `runtime_${status}`;
        break;
      }
    }
    await Bun.sleep(1000);
  }
} finally {
  // 4. Reap.
  if (!args.keep) {
    await provider.terminate(target, handle, "smoke done");
    mark("terminated");
    const leftovers = (await provider.list(target, ownerId)).filter(
      (h) => h.externalId === handle.externalId,
    );
    console.log(`[smoke] list() after terminate: ${leftovers.length} matching runtime(s)`);
    leftoversAfterTerminate = leftovers.length;
  }
}

console.log(
  JSON.stringify({
    provider: kind,
    image: args.image,
    finalStatus,
    agentId,
    ownerId,
    taskId: task.id,
    marksMs: marks,
  }),
);
if (finalStatus !== "completed" || leftoversAfterTerminate > 0) process.exitCode = 1;
