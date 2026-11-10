import { afterAll, beforeAll, expect, test } from "bun:test";
import { closeDb, getDbClient, initDb } from "../be/db";
import { listRuntimeInstancesForPool, upsertRuntimeInstance } from "../be/multi-runtime";
import { clearRuntimeOwnerIdCache, getControllerCommands } from "../be/runtime-pools/controllers";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
  updateRuntimePool,
} from "../be/runtime-pools/db";
import { reconcileOnce, stopRuntimeSupervisor } from "../be/runtime-pools/supervisor";
import { resolveBySessionToken } from "../be/users";
import { RUNTIME_LABELS } from "../runtime-providers/types";

const path = "./test-runtime-k8s-pools.sqlite";
const keys = ["RUNTIME_POOLS_ENABLED", "MULTI_RUNTIME_ENABLED"];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
let server: Bun.Server<undefined>;
const token = crypto.randomUUID();
type WorkerPod = {
  metadata: {
    name: string;
    namespace: string;
    uid: string;
    labels: Record<string, string>;
    creationTimestamp: string;
  };
  spec: {
    containers: Array<{ env: Array<{ name: string; value: string }> }>;
    activeDeadlineSeconds: number;
  };
};
const pods = new Map<string, WorkerPod>();
const deleted: string[] = [];

beforeAll(() => {
  initDb(path);
  process.env.RUNTIME_POOLS_ENABLED = "true";
  process.env.MULTI_RUNTIME_ENABLED = "true";
  clearRuntimeOwnerIdCache();
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      expect(req.headers.get("authorization")).toBe(`Bearer ${token}`);
      const url = new URL(req.url);
      const name = url.pathname.split("/")[6];
      if (req.method === "POST") {
        const pod = (await req.json()) as WorkerPod;
        pod.metadata.uid = crypto.randomUUID();
        pod.metadata.creationTimestamp = new Date().toISOString();
        pods.set(pod.metadata.name, pod);
        return Response.json(pod);
      }
      if (!name) return Response.json({ items: [...pods.values()], metadata: {} });
      const pod = pods.get(name);
      if (!pod) return Response.json({}, { status: 404 });
      if (req.method === "DELETE") {
        const body = (await req.json()) as { preconditions: { uid: string } };
        expect(body.preconditions.uid).toBe(pod.metadata.uid);
        pods.delete(name);
        deleted.push(name);
        return Response.json({});
      }
      return Response.json({ ...pod, status: { phase: "Running" } });
    },
  });
});

afterAll(async () => {
  await stopRuntimeSupervisor();
  await server.stop(true);
  closeDb();
  clearRuntimeOwnerIdCache();
  for (const suffix of ["", "-wal", "-shm"])
    await Bun.file(path + suffix)
      .delete()
      .catch(() => {});
  for (const key of keys) {
    if (previous[key] === undefined) delete process.env[key];
    else process.env[key] = previous[key];
  }
});

test("the supervisor provisions, registers, and terminates Kubernetes runtimes through the builtin controller", async () => {
  const controller = await createRuntimeController({
    name: "k8s",
    kind: "k8s",
    placement: "builtin",
    config: {
      K8S_API_URL: server.url.origin,
      K8S_NAMESPACE: "workers",
      WORKER_API_URL: "https://swarm.test",
    },
    secretConfig: { K8S_TOKEN: token },
  });
  const pool = await createRuntimePool({
    name: "k8s",
    kind: "k8s",
    placements: [controller.id],
    image: "worker:test",
    minRuntimes: 1,
    maxRuntimes: 1,
    ttlSec: 120,
    idleMinutes: null,
  });
  const agent = await createPoolAgent(pool.id, { name: "k8s-worker" });
  await reconcileOnce();
  expect(pods.size).toBe(1);
  const [runtime] = await listRuntimeInstancesForPool(pool.id);
  expect(runtime?.status).toBe("provisioning");
  const pod = [...pods.values()][0]!;
  expect(pod.metadata.labels[RUNTIME_LABELS.runtimeId]).toBe(runtime!.id);
  expect(pod.metadata.labels[RUNTIME_LABELS.agentId]).toBe(agent.id);
  expect(pod.spec.activeDeadlineSeconds).toBe(120);
  const env = Object.fromEntries(
    pod.spec.containers[0]!.env.map(({ name, value }) => [name, value]),
  );
  expect(env.MCP_BASE_URL).toBe("https://swarm.test");
  expect(env.AGENT_SWARM_API_KEY).toStartWith("aseph_");
  expect((await resolveBySessionToken(env.AGENT_SWARM_API_KEY!))?.runtimeId).toBe(runtime!.id);
  const row = await getDbClient().get<{ external_handle: string }>(
    "SELECT external_handle FROM runtime_instances WHERE id = ?",
    [runtime!.id],
  );
  const handle = JSON.parse(row!.external_handle);
  expect(handle.controllerId).toBe(controller.id);
  expect(handle.meta["k8s.uid"]).toBe(pod.metadata.uid);
  const commands = await getControllerCommands(controller.id);
  expect(await commands.list(pod.metadata.labels[RUNTIME_LABELS.owner]!)).toHaveLength(1);
  expect((await commands.status([handle]))[handle.externalId]).toBe("running");
  await upsertRuntimeInstance({ id: runtime!.id, agentId: agent.id, reportedSlots: 1 });
  expect((await listRuntimeInstancesForPool(pool.id))[0]?.status).toBe("active");
  await updateRuntimePool(pool.id, { enabled: false });
  await reconcileOnce();
  expect((await listRuntimeInstancesForPool(pool.id))[0]?.draining).toBe(true);
  await reconcileOnce();
  expect(pods.size).toBe(0);
  expect(deleted).toEqual([pod.metadata.name]);
  expect((await listRuntimeInstancesForPool(pool.id))[0]?.status).toBe("offline");
  expect(await resolveBySessionToken(env.AGENT_SWARM_API_KEY!)).toBeNull();
});
