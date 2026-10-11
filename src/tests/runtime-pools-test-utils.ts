import { afterAll, afterEach, beforeAll, beforeEach, spyOn } from "bun:test";
import { closeDb, createTaskExtended, getDbClient, initDb } from "../be/db";
import * as controllers from "../be/runtime-pools/controllers";
import {
  createPoolAgent,
  createRuntimeController,
  createRuntimePool,
} from "../be/runtime-pools/db";
import { stopRuntimeSupervisor } from "../be/runtime-pools/supervisor";
import type { ProvisionRequest, RuntimeHandle, RuntimeStatus } from "../runtime-providers";
import type { ControllerCommands } from "../runtime-providers/controller";

export class FailureTestController implements ControllerCommands {
  readonly traits = { canProvision: true, ephemeralDisk: true, supportsPause: false };
  requests: ProvisionRequest[] = [];
  terminated: string[] = [];
  runtimes = new Map<string, { handle: RuntimeHandle; status: RuntimeStatus }>();
  failure: string | null = null;
  listed = true;
  statusCalls: RuntimeHandle[][] = [];

  async provision(req: ProvisionRequest): Promise<RuntimeHandle> {
    this.requests.push(req);
    if (this.failure) throw new Error(this.failure);
    const handle: RuntimeHandle = { kind: "docker", externalId: crypto.randomUUID() };
    this.runtimes.set(handle.externalId, { handle, status: "running" });
    return handle;
  }
  async terminate(handle: RuntimeHandle): Promise<void> {
    this.terminated.push(handle.externalId);
    this.runtimes.delete(handle.externalId);
  }
  async status(handles: RuntimeHandle[]): Promise<Record<string, RuntimeStatus>> {
    this.statusCalls.push(handles);
    return Object.fromEntries(
      handles.map((h) => [h.externalId, this.runtimes.get(h.externalId)?.status ?? "exited"]),
    );
  }
  async list(): Promise<RuntimeHandle[]> {
    return this.listed ? [...this.runtimes.values()].map((r) => r.handle) : [];
  }
}

export function runtimeFailureFixture(dbPath: string) {
  const keys = [
    "RUNTIME_POOLS_ENABLED",
    "MULTI_RUNTIME_ENABLED",
    "RUNTIME_PROVISION_CONCURRENCY",
    "RUNTIME_PROVISION_TIMEOUT_SEC",
    "RUNTIME_PROVISION_MAX_ATTEMPTS",
    "RUNTIME_CIRCUIT_THRESHOLD",
    "RUNTIME_CIRCUIT_OPEN_MIN",
    "RUNTIME_SOCKET_GRACE_SEC",
    "RUNTIME_TOKEN_ROTATE_BEFORE_MIN",
    "HEARTBEAT_MAX_RESUME_GENERATIONS",
    "RUNTIME_WAKE_GRACE_SEC",
    "HEARTBEAT_STALE_CLEANUP_MIN",
  ];
  const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const state = { fake: new FailureTestController(), controllerId: "" };
  let commandsSpy: ReturnType<typeof spyOn<typeof controllers, "getControllerCommands">>;
  let errorSpy: ReturnType<typeof spyOn<typeof console, "error">>;
  beforeAll(() => {
    closeDb();
    initDb(dbPath);
  });
  beforeEach(async () => {
    await stopRuntimeSupervisor();
    for (const key of keys) delete process.env[key];
    process.env.RUNTIME_POOLS_ENABLED = "true";
    process.env.MULTI_RUNTIME_ENABLED = "true";
    for (const table of [
      "active_sessions",
      "runtime_instances",
      "session_tokens",
      "agent_tasks",
      "agents",
      "runtime_pools",
      "runtime_controllers",
      "swarm_config",
    ])
      await getDbClient().run(`DELETE FROM ${table}`);
    state.fake = new FailureTestController();
    state.controllerId = (
      await createRuntimeController({
        name: "test-controller",
        kind: "docker",
        placement: "builtin",
      })
    ).id;
    commandsSpy = spyOn(controllers, "getControllerCommands").mockImplementation(
      async () => state.fake,
    );
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(async () => {
    await stopRuntimeSupervisor();
    commandsSpy.mockRestore();
    errorSpy.mockRestore();
  });
  afterAll(async () => {
    closeDb();
    for (const suffix of ["", "-wal", "-shm"])
      await Bun.file(dbPath + suffix)
        .delete()
        .catch(() => {});
    for (const key of keys) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  });
  return {
    state,
    async setup(options: Partial<Parameters<typeof createRuntimePool>[0]> = {}, maxTasks = 2) {
      const pool = await createRuntimePool({
        name: crypto.randomUUID(),
        kind: "docker",
        placements: [state.controllerId],
        image: "test-worker",
        idleMinutes: null,
        ...options,
      });
      const agent = await createPoolAgent(pool.id, { name: crypto.randomUUID(), maxTasks });
      const task = await createTaskExtended("Do the waiting work", { agentId: agent.id });
      return { pool, agent, task };
    },
  };
}
