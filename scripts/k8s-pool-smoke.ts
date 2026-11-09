#!/usr/bin/env bun
import { parseArgs } from "node:util";
import type { RuntimeHandle } from "../src/runtime-providers/types";
import { getApiKey } from "../src/utils/api-key";
import { registerVolatileSecret, scrubSecrets } from "../src/utils/secret-scrubber";

type Runtime = { id: string; status: string; externalHandle: RuntimeHandle | null };
type Pod = {
  metadata: { name: string; uid: string; labels: Record<string, string> };
  spec: {
    automountServiceAccountToken: boolean;
    restartPolicy: string;
    containers: Array<{
      name: string;
      resources: { limits: { cpu: string; memory: string } };
      env: Array<{ name: string; value: string }>;
    }>;
  };
};

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function waitFor<T>(
  check: () => Promise<T | undefined>,
  timeoutMs: number,
  label: string,
  signal?: AbortSignal,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const result = await check();
    if (result !== undefined) return result;
    await Bun.sleep(2_000);
  }
  throw new Error(`${label} timed out.`);
}

async function main() {
  const key = getApiKey();
  if (key) registerVolatileSecret(key, "k8s-smoke-api-key");
  const { values: args } = parseArgs({
    options: {
      help: { type: "boolean" },
      api: { type: "string" },
      "worker-api": { type: "string" },
      namespace: { type: "string" },
      context: { type: "string" },
      image: { type: "string", default: "ghcr.io/desplega-ai/agent-swarm-worker:slim" },
      "timeout-sec": { type: "string", default: "600" },
    },
  });
  if (args.help) {
    console.log(`Usage: bun scripts/k8s-pool-smoke.ts --api <test-api-url> \\
  --worker-api <worker-reachable-api-url> --namespace <test-worker-namespace> \\
  [--context <kubectl-context>] [--image <worker-image>] [--timeout-sec <seconds>]

Credentials: AGENT_SWARM_API_KEY (or legacy API_KEY), plus the local kubectl configuration.
The API must run inside Kubernetes with both runtime flags and namespace-scoped pod permissions.
The namespace must already exist. This script creates its own controller, pool, and agent.
Cleanup drains the pool and deletes its pods, pool, and controller, including after test failures.
Use a disposable test API. The API retains the offline agent and runtime history.
The script does not create tasks or create or delete cloud servers.`);
    return;
  }
  check(
    args.api && args["worker-api"] && args.namespace,
    "Set --api, --worker-api, and --namespace.",
  );
  check(key, "Set AGENT_SWARM_API_KEY or API_KEY.");
  for (const value of [args.api, args["worker-api"]]) {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error("API URLs must be valid HTTP or HTTPS URLs.");
    }
    check(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash,
      "API URLs must use HTTP or HTTPS without credentials, queries, or fragments.",
    );
  }
  const timeoutMs = Number(args["timeout-sec"]) * 1_000;
  check(Number.isSafeInteger(timeoutMs) && timeoutMs > 0, "Set a positive --timeout-sec.");
  const baseUrl = args.api.replace(/\/$/, "");
  const namespace = args.namespace;
  const context = args.context ? ["--context", args.context] : [];
  const runName = `k8s-smoke-${crypto.randomUUID().slice(0, 8)}`;
  const stop = new AbortController();
  const interrupt = () => stop.abort(new Error("Smoke test interrupted."));
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);

  async function api<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: "error",
      signal: AbortSignal.timeout(30_000),
    });
    // Failure bodies can contain worker environment values.
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Swarm ${method} ${path} failed (${response.status}).`);
    }
    return (response.status === 204 ? undefined : await response.json()) as T;
  }

  async function pods(selector: string): Promise<Pod[]> {
    const result = await Bun.$`kubectl ${context} -n ${namespace} get pods -l ${selector} -o json`
      .quiet()
      .nothrow();
    check(
      result.exitCode === 0,
      "kubectl could not read test pods. Check its context and namespace permissions.",
    );
    return (JSON.parse(result.stdout.toString()) as { items: Pod[] }).items;
  }

  let controllerId: string | undefined;
  let poolId: string | undefined;
  try {
    const status = await api<{ runtime_pools: { enabled: boolean; supervisor: string } }>(
      "GET",
      "/status",
    );
    check(
      status.runtime_pools?.enabled && status.runtime_pools.supervisor === "running",
      "Enable both runtime flags and start the pool supervisor.",
    );
    await pods(`swarm.runtime-id=${crypto.randomUUID()}`);
    console.log(`[k8s-smoke] ${runName}: creating test resources.`);
    const controller = await api<{ controller: { id: string; secretConfigKeys: string[] } }>(
      "POST",
      "/api/runtime-controllers",
      {
        name: runName,
        kind: "k8s",
        placement: "builtin",
        config: { K8S_NAMESPACE: namespace, WORKER_API_URL: args["worker-api"] },
      },
    );
    controllerId = controller.controller.id;
    check(
      controller.controller.secretConfigKeys.length === 0,
      "The controller unexpectedly needs stored cluster credentials.",
    );
    const created = await api<{ pool: { id: string } }>("POST", "/api/runtime-pools", {
      name: runName,
      kind: "k8s",
      placements: [controllerId],
      image: args.image,
      minRuntimes: 1,
      maxRuntimes: 1,
      slotsPerRuntime: 1,
      idleMinutes: null,
      resources: { cpu: 1, memoryMb: 2048 },
      env: { DESPLEGA_TELEMETRY_ENV: "test", ANONYMIZED_TELEMETRY: "false" },
    });
    poolId = created.pool.id;
    const agent = await api<{ agent: { id: string } }>(
      "POST",
      `/api/runtime-pools/${poolId}/agents`,
      { name: runName, maxTasks: 1 },
    );
    const runtime = await waitFor(
      async () => {
        const rows = await api<{ runtimes: Runtime[] }>(
          "GET",
          `/api/runtime-pools/${poolId}/runtimes`,
        );
        return rows.runtimes.find((row) => row.status === "active");
      },
      timeoutMs,
      "Worker registration",
      stop.signal,
    );
    const [pod] = await pods(`swarm.runtime-id=${runtime.id}`);
    check(pod, "The registered runtime has no pod in the selected cluster.");
    check(
      runtime.externalHandle?.kind === "k8s" &&
        runtime.externalHandle.controllerId === controllerId,
      "Runtime controller identity differs.",
    );
    check(
      runtime.externalHandle.meta?.["k8s.uid"] === pod.metadata.uid &&
        runtime.externalHandle.externalId === pod.metadata.name,
      "Runtime pod identity differs.",
    );
    check(
      pod.metadata.labels["swarm.agent-id"] === agent.agent.id &&
        pod.metadata.labels["swarm.pool-id"] === poolId,
      "Pod ownership labels differ.",
    );
    check(
      pod.spec.automountServiceAccountToken === false && pod.spec.restartPolicy === "Never",
      "Worker pod token or restart policy differs.",
    );
    const worker = pod.spec.containers.find((container) => container.name === "worker");
    check(
      worker &&
        ["1", "1000m"].includes(worker.resources.limits.cpu) &&
        ["2Gi", "2048Mi"].includes(worker.resources.limits.memory),
      "Worker resource limits differ.",
    );
    check(
      worker.env.some(
        (entry) => entry.name === "AGENT_SWARM_API_KEY" && entry.value.startsWith("aseph_"),
      ),
      "Worker did not receive a scoped runtime credential.",
    );
    const rows = await api<{ runtimes: Runtime[] }>("GET", `/api/runtime-pools/${poolId}/runtimes`);
    check(
      rows.runtimes.filter((row) => row.status !== "offline").length === 1,
      "Pool capacity exceeded one runtime.",
    );
    console.log(
      "[k8s-smoke] PASS: in-cluster auth, worker registration, pod identity, resource limits, and capacity.",
    );
  } finally {
    try {
      if (poolId) {
        await api("PATCH", `/api/runtime-pools/${poolId}`, { enabled: false });
        await waitFor(
          async () => {
            const rows = await api<{ runtimes: Runtime[] }>(
              "GET",
              `/api/runtime-pools/${poolId}/runtimes`,
            );
            return rows.runtimes.every((row) => row.status === "offline") &&
              (await pods(`swarm.pool-id=${poolId}`)).length === 0
              ? true
              : undefined;
          },
          120_000,
          "Pool teardown",
        );
        await api("DELETE", `/api/runtime-pools/${poolId}?force=true`);
      }
      if (controllerId) await api("DELETE", `/api/runtime-controllers/${controllerId}`);
      if (poolId)
        console.log("[k8s-smoke] PASS: drained pool, deleted pods, pool, and controller.");
    } finally {
      process.removeListener("SIGINT", interrupt);
      process.removeListener("SIGTERM", interrupt);
    }
  }
}

try {
  await main();
} catch (error) {
  console.error(scrubSecrets(String(error)));
  process.exitCode = 1;
}
