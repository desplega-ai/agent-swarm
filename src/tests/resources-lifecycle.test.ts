import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { resolveResourceAccess } from "../be/resources/access";
import {
  createBrowserProfile,
  getResource,
  getResourcePrivate,
  insertResourceOperation,
} from "../be/resources/db";
import { claimOperation, getOperation } from "../be/resources/operations";
import { ResourceReconciler } from "../be/resources/reconciler";
import { ResourceService } from "../be/resources/service";
import { sealJson } from "../be/sealed-json";
import { createFakeResourceProvider } from "../resource-providers/fake";
import type { ProviderOperationContext, ResourceProvider } from "../resource-providers/types";
import { removeResourceTestDb } from "./resources-test-utils";

const templateGlobals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
let savedTemplate: Uint8Array | undefined;
beforeAll(() => {
  savedTemplate = templateGlobals.__testMigrationTemplate;
  templateGlobals.__testMigrationTemplate = undefined;
});
afterAll(() => {
  templateGlobals.__testMigrationTemplate = savedTemplate;
});
const path = `./test-resources-lifecycle-${crypto.randomUUID()}.sqlite`;
let time: number;
const now = () => new Date(time);
function reopen() {
  const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
  const saved = globals.__testMigrationTemplate;
  globals.__testMigrationTemplate = undefined;
  closeDb();
  try {
    initDb(path);
  } finally {
    globals.__testMigrationTemplate = saved;
  }
}
async function reserved(id: string) {
  return (
    (
      await getDbClient().get<{ liveReservation: number }>(
        "SELECT liveReservation FROM resources WHERE id=?",
        [id],
      )
    )?.liveReservation === 1
  );
}
beforeEach(async () => {
  closeDb();
  await removeResourceTestDb(path);
  initDb(path);
  time = Date.parse("2026-11-08T12:00:00.000Z");
});
afterEach(async () => {
  closeDb();
  await removeResourceTestDb(path);
  delete process.env.RESOURCE_PREVIEW_ACCESS;
});
async function fixture(kind: "sandbox" | "browser" = "sandbox") {
  const agent = await createAgent({ name: "resource lifecycle", isLead: false, status: "idle" });
  const user = await createUser({ name: "owner" });
  const task = await createTaskExtended("source", {
    agentId: agent.id,
    requestedByUserId: user.id,
  });
  const access = (await resolveResourceAccess({ kind: "agent", agentId: agent.id }, task.id))!;
  const adapter = createFakeResourceProvider(kind, now);
  let calls = 0;
  const create = adapter.create.bind(adapter);
  adapter.create = async (input, context) => {
    calls++;
    return create(input, context);
  };
  const service = () =>
    new ResourceService({ ownerId: "swarm-test", now, provider: async () => adapter });
  const input = () => ({ kind, provider: "fake" as const, key: crypto.randomUUID() });
  return { agent, user, task, access, adapter, service, input, calls: () => calls };
}
test("independent service instances atomically enforce tree caps for simultaneous create and resume", async () => {
  const f = await fixture();
  const a = f.service(),
    b = f.service();
  const results = await Promise.allSettled(
    Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).create(f.access, f.input())),
  );
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(3);
  expect(f.calls()).toBe(0);
  for (const result of results) if (result.status === "fulfilled") await a.execute(result.value.id);
  expect(f.calls()).toBe(3);
  const running = await getDbClient().query<{ id: string }>("SELECT id FROM resources");
  const pause = await a.action(f.access, running[0]!.id, "pause", "pause");
  await a.execute(pause.id);
  const attempts = await Promise.allSettled([
    a.action(f.access, running[0]!.id, "resume", "resume"),
    b.create(f.access, f.input()),
  ]);
  expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await getDbClient().get<{ n: number }>(
        "SELECT COUNT(*) n FROM resources WHERE liveReservation=1",
      )
    )?.n,
  ).toBe(3);
});
test("swarm cap covers unrelated task trees across service instances", async () => {
  const f = await fixture();
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_SWARM_CAP", value: "1" });
  const second = await createTaskExtended("other root", {
    agentId: f.agent.id,
    requestedByUserId: f.user.id,
  });
  const access = (await resolveResourceAccess({ kind: "agent", agentId: f.agent.id }, second.id))!;
  const result = await Promise.allSettled([
    f.service().create(f.access, f.input()),
    f.service().create(access, f.input()),
  ]);
  expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(f.calls()).toBe(0);
});
test("provider creation before process loss reconciles once after DB reopen", async () => {
  const f = await fixture();
  const a = f.service();
  const op = await a.create(f.access, f.input());
  await claimOperation(op.id, now(), "crashed-process");
  await getDbClient().run(
    "UPDATE resource_operations SET mutationStartedAt=?,providerDeadlineAt=? WHERE id=?",
    [now().toISOString(), new Date(time + 60000).toISOString(), op.id],
  );
  await getDbClient().run(
    "UPDATE resource_billing SET active=1,billableEndsAt=leaseEndsAt WHERE resourceId=?",
    [op.resourceId],
  );
  await f.adapter.create({
    ownerId: "swarm-test",
    resourceId: op.resourceId,
    generation: 1,
    timeoutMs: 60_000,
    config: {},
  });
  time += 31_000;
  reopen();
  const b = f.service();
  await new ResourceReconciler(b).tick();
  expect(f.calls()).toBe(1);
  expect((await getOperation(op.id))?.status).toBe("succeeded");
  expect((await getResource(op.resourceId))?.state).toBe("running");
  await b.execute(op.id);
  expect(f.calls()).toBe(1);
});
test("uncertain absent create never repeats, including after restart", async () => {
  const f = await fixture();
  const a = f.service();
  const op = await a.create(f.access, f.input());
  f.adapter.create = async () => {
    throw new Error("provider timeout");
  };
  await a.execute(op.id);
  reopen();
  await f.service().execute(op.id);
  expect((await getOperation(op.id))?.status).toBe("uncertain");
  expect(await reserved(op.resourceId)).toBe(true);
});
test("failed stop retains capacity until confirmed termination", async () => {
  const f = await fixture("browser");
  const a = f.service();
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  const adapter = f.adapter as Extract<ResourceProvider, { kind: "browser" }>;
  const stop = adapter.stop.bind(adapter);
  adapter.stop = async () => {
    throw new Error("stop failed");
  };
  const close = await a.action(f.access, op.resourceId, "stop", "close");
  await a.execute(close.id);
  expect(await reserved(op.resourceId)).toBe(true);
  adapter.stop = stop;
  time += 5000;
  await f.service().execute(close.id);
  expect((await getResource(op.resourceId))?.state).toBe("stopped");
  expect(await reserved(op.resourceId)).toBe(false);
});
test("stale generation pause, destroy, and refresh cannot install a stale handle", async () => {
  for (const kind of ["pause", "destroy", "refresh"] as const) {
    const f = await fixture();
    const a = f.service();
    const op = await a.create(f.access, f.input());
    await a.execute(op.id);
    const stale = await insertResourceOperation({
      resourceId: op.resourceId,
      generation: 1,
      kind,
      idempotencyKey: kind,
    });
    await getDbClient().run("UPDATE resources SET generation=2 WHERE id=?", [op.resourceId]);
    await f.service().execute(stale.id);
    expect((await getResource(op.resourceId))?.generation).toBe(2);
    expect((await getResource(op.resourceId))?.state).toBe("running");
  }
});
test("handle installation validates reserved resource ID and generation", async () => {
  const f = await fixture();
  const a = f.service();
  const original = f.adapter.create.bind(f.adapter);
  f.adapter.create = async (input) => ({
    ...(await original(input)),
    resourceId: crypto.randomUUID(),
  });
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  expect((await getResourcePrivate(op.resourceId))?.handle).toBe(null);
  expect((await getOperation(op.id))?.status).toBe("uncertain");
});
test("denied authorization, private mode, and denied resume make zero provider calls", async () => {
  const f = await fixture();
  const a = f.service();
  await expect(
    a.create({ ...f.access, taskId: undefined as unknown as null }, f.input()),
  ).rejects.toThrow();
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_PREVIEW_ACCESS", value: "private" });
  await expect(a.create(f.access, f.input())).rejects.toThrow("Private");
  expect(f.calls()).toBe(0);
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_PREVIEW_ACCESS", value: "public" });
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  const pause = await a.action(f.access, op.resourceId, "pause", "pause");
  await a.execute(pause.id);
  let resumeCalls = 0;
  f.adapter.resume = async (h) => {
    resumeCalls++;
    return h;
  };
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_PREVIEW_ACCESS", value: "private" });
  await expect(a.action(f.access, op.resourceId, "resume", "resume")).rejects.toThrow("Private");
  expect(resumeCalls).toBe(0);
});
test("one active browser per profile, explicit reopen increments generation, destroy is terminal", async () => {
  const f = await fixture("browser");
  const a = f.service();
  const profile = await createBrowserProfile({
    name: "shared",
    provider: "fake",
    ownerScope: "swarm",
  });
  const input = { ...f.input(), profileId: profile.id };
  const op = await a.create(f.access, input);
  await a.execute(op.id);
  await expect(f.service().create(f.access, { ...input, key: "another" })).rejects.toThrow();
  const stop = await a.action(f.access, op.resourceId, "stop", "stop");
  await a.execute(stop.id);
  const resume = await a.action(f.access, op.resourceId, "resume", "resume");
  await a.execute(resume.id);
  expect((await getResource(op.resourceId))?.generation).toBe(2);
  const destroy = await a.action(f.access, op.resourceId, "destroy", "destroy");
  await a.execute(destroy.id);
  await expect(a.action(f.access, op.resourceId, "resume", "again")).rejects.toThrow("destroyed");
});
test("budget admission shortens leases and provider timeout bounds exposure without API availability", async () => {
  const f = await fixture();
  const a = f.service();
  await getDbClient().run(
    "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES ('global','',0.01,0,0)",
  );
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  const resource = (await getResource(op.resourceId))!;
  expect(Date.parse(resource.runningLeaseExpiresAt!) - time).toBe(10_000);
  time += 10_000;
  const privateData = await getResourcePrivate(op.resourceId);
  expect(
    await f.adapter.status(privateData!.handle as Parameters<typeof f.adapter.status>[0]),
  ).toBe("paused");
  await expect(f.service().action(f.access, op.resourceId, "touch", "touch")).rejects.toThrow();
  await new ResourceReconciler(f.service()).tick();
  expect((await getResource(op.resourceId))?.state).toBe("paused");
  expect((await getResource(op.resourceId))?.lastActivityAt).toBe(resource.lastActivityAt);
});
test("interrupted arbitrary commands remain uncertain and shutdown rejects work", async () => {
  const f = await fixture();
  const a = f.service();
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  let calls = 0;
  if (f.adapter.kind === "sandbox")
    f.adapter.exec = async () => {
      calls++;
      throw new Error("must not run");
    };
  for (const kind of ["setup", "exec", "refresh"] as const) {
    const command = await insertResourceOperation({
      resourceId: op.resourceId,
      generation: 1,
      kind,
      idempotencyKey: kind,
    });
    await a.execute(command.id);
    await f.service().execute(command.id);
    expect((await getOperation(command.id))?.status).toBe("uncertain");
  }
  expect(calls).toBe(0);
  a.shutdown();
  await expect(a.create(f.access, f.input())).rejects.toThrow("shutdown");
});

test("separate processes share atomic admission and conditional operation leases", async () => {
  const { runChild, expectChildOk } = await import("./test-proc");
  const f = await fixture();
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_TREE_CAP", value: "1" });
  const run = async (mode: string, reference = "") => {
    const child = expectChildOk(
      await runChild(
        [
          process.execPath,
          "src/tests/fixtures/resources-process.ts",
          path,
          f.agent.id,
          f.task.id,
          mode,
          reference,
        ],
        { env: { ...process.env, DESPLEGA_TELEMETRY_ENV: "test" } },
      ),
      "resource admission child",
    );
    return JSON.parse(child.stdout.trim().split("\n").at(-1)!) as {
      accepted: boolean;
      calls: number;
    };
  };
  const created = await Promise.all(Array.from({ length: 4 }, () => run("create")));
  expect(created.filter((r) => r.accepted)).toHaveLength(1);
  expect(created.every((r) => r.calls === 0)).toBe(true);
  const op = (await getDbClient().get<{ id: string; resourceId: string }>(
    "SELECT id,resourceId FROM resource_operations LIMIT 1",
  ))!;
  const claims = await Promise.all([run("claim", op.id), run("claim", op.id)]);
  expect(claims.filter((r) => r.accepted)).toHaveLength(1);
  await getDbClient().run(
    "UPDATE resource_operations SET status='succeeded',leaseOwner=NULL,leaseExpiresAt=NULL WHERE id=?",
    [op.id],
  );
  await getDbClient().run(
    "UPDATE resources SET state='paused',liveReservation=0,leaseOwner=NULL,leaseExpiresAt=NULL WHERE id=?",
    [op.resourceId],
  );
  const mixed = await Promise.all([run("resume", op.resourceId), run("create")]);
  expect(mixed.filter((r) => r.accepted)).toHaveLength(1);
  expect(mixed.every((r) => r.calls === 0)).toBe(true);
  expect(
    (
      await getDbClient().get<{ n: number }>(
        "SELECT COUNT(*) n FROM resources WHERE liveReservation=1",
      )
    )?.n,
  ).toBe(1);
}, 35_000);

test("authenticated renewal rechecks assignment before any provider effect", async () => {
  const f = await fixture();
  const a = f.service();
  const op = await a.create(f.access, f.input());
  await getDbClient().run("UPDATE agent_tasks SET agentId=NULL WHERE id=?", [f.task.id]);
  await a.execute(op.id);
  expect(f.calls()).toBe(0);
  expect((await getOperation(op.id))?.status).toBe("failed");
});

test("read polling and orphan discovery never renew activity or touch foreign ownership", async () => {
  const f = await fixture();
  const a = f.service();
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  const before = (await getResource(op.resourceId))!;
  await f.adapter.create({
    ownerId: "foreign-swarm",
    resourceId: crypto.randomUUID(),
    generation: 1,
    timeoutMs: 60_000,
    config: {},
  });
  await f.adapter.create({
    ownerId: "swarm-test",
    resourceId: crypto.randomUUID(),
    generation: 1,
    timeoutMs: 60_000,
    config: {},
  });
  time += 10_000;
  await a.poll(f.access, op.id, 3);
  const reconciler = new ResourceReconciler(a);
  expect(await reconciler.discoverOwned()).toHaveLength(1);
  const after = (await getResource(op.resourceId))!;
  expect(after.lastActivityAt).toBe(before.lastActivityAt);
  expect(after.runningLeaseExpiresAt).toBe(before.runningLeaseExpiresAt);
});

test("expired operation completion cannot overwrite the successor lease or generation", async () => {
  const f = await fixture();
  const a = f.service();
  const b = f.service();
  let release!: () => void;
  let entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const create = f.adapter.create.bind(f.adapter);
  f.adapter.create = async (input, context) => {
    const handle = await create(input, context);
    entered();
    await gate;
    return handle;
  };
  const op = await a.create(f.access, f.input());
  const old = a.execute(op.id);
  await started;
  time += 31_000;
  await b.execute(op.id);
  expect((await getOperation(op.id))?.status).toBe("succeeded");
  await getDbClient().run(
    "UPDATE resources SET generation=2,state='destroyed',liveReservation=0 WHERE id=?",
    [op.resourceId],
  );
  release();
  await old;
  expect((await getResource(op.resourceId))?.generation).toBe(2);
  expect((await getResource(op.resourceId))?.state).toBe("destroyed");
});

test("idle browser stop and inactivity destruction preserve the last authenticated activity", async () => {
  const f = await fixture("browser");
  const a = f.service();
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_IDLE_MS", value: "1000" });
  const op = await a.create(f.access, f.input());
  await a.execute(op.id);
  const initial = (await getResource(op.resourceId))!;
  time += 1001;
  await new ResourceReconciler(f.service()).tick();
  expect((await getResource(op.resourceId))?.state).toBe("stopped");
  time = Date.parse(initial.expiresAt) + 1;
  await new ResourceReconciler(f.service()).tick();
  const expired = (await getResource(op.resourceId))!;
  expect(expired.state).toBe("destroyed");
  expect(expired.lastActivityAt).toBe(initial.lastActivityAt);
});

test("exhausted budgets deny creation, resume, and renewal before provider calls", async () => {
  const f = await fixture();
  const a = f.service();
  await getDbClient().run(
    "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES ('global','',0.01,0,0)",
  );
  const op = await a.create(f.access, f.input());
  await expect(f.service().create(f.access, f.input())).rejects.toThrow("budget");
  expect(f.calls()).toBe(0);
  await a.execute(op.id);
  const pause = await a.action(f.access, op.resourceId, "pause", "pause");
  await a.execute(pause.id);
  await getDbClient().run("UPDATE budgets SET daily_budget_usd=0 WHERE scope='global'");
  let resume = 0;
  f.adapter.resume = async (h) => {
    resume++;
    return h;
  };
  await expect(a.action(f.access, op.resourceId, "resume", "denied")).rejects.toThrow("budget");
  expect(resume).toBe(0);
  expect(f.calls()).toBe(1);
});

test("queued expired create releases its profile, reserves no cost, and never calls create", async () => {
  const f = await fixture("browser");
  const service = f.service();
  const profile = await createBrowserProfile({
    name: "queued",
    provider: "fake",
    ownerScope: "swarm",
  });
  const op = await service.create(f.access, { ...f.input(), profileId: profile.id });
  time += 61000;
  const { checkpointCosts } = await import("../be/resources/costs");
  await checkpointCosts(now());
  expect(await getDbClient().query("SELECT * FROM resource_costs")).toHaveLength(0);
  reopen();
  await f.service().execute(op.id);
  expect((await getOperation(op.id))?.status).toBe("failed");
  expect(await reserved(op.resourceId)).toBe(false);
  expect(f.calls()).toBe(0);
  await expect(
    service.create(f.access, { ...f.input(), profileId: profile.id }),
  ).resolves.toBeDefined();
});

test("execute-time authorization denial restores stopped browser and paused sandbox without phantom charges", async () => {
  for (const kind of ["browser", "sandbox"] as const) {
    const f = await fixture(kind);
    const service = f.service();
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    const stop = await service.action(
      f.access,
      op.resourceId,
      kind === "browser" ? "stop" : "pause",
      "stop",
    );
    await service.execute(stop.id);
    const prior = (await getResource(op.resourceId))!;
    const resume = await service.action(f.access, op.resourceId, "resume", "denied-execute");
    await getDbClient().run("UPDATE agent_tasks SET agentId=NULL WHERE id=?", [f.task.id]);
    reopen();
    await f.service().execute(resume.id);
    const current = (await getResource(op.resourceId))!;
    expect(current.state).toBe(prior.state);
    expect(current.generation).toBe(prior.generation + (kind === "browser" ? 1 : 0));
    expect(current.runningLeaseExpiresAt).toBe(prior.runningLeaseExpiresAt);
    expect(await reserved(op.resourceId)).toBe(false);
    expect(f.calls()).toBe(1);
    expect((await getOperation(resume.id))?.status).toBe("failed");
    if (kind === "browser") {
      expect((await getResourcePrivate(op.resourceId))?.handle).toBeNull();
      await getDbClient().run("UPDATE agent_tasks SET agentId=? WHERE id=?", [
        f.agent.id,
        f.task.id,
      ]);
      const retry = await service.action(f.access, op.resourceId, "resume", "authorized-retry");
      await service.execute(retry.id);
      expect((await getResource(op.resourceId))?.generation).toBe(prior.generation + 2);
      expect((await getOperation(retry.id))?.status).toBe("succeeded");
    }
  }
});

test("denied pause and destroy preserve confirmed running lease and its billing", async () => {
  for (const action of ["pause", "destroy"] as const) {
    const f = await fixture();
    const service = f.service();
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    const prior = (await getResource(op.resourceId))!;
    time += 1000;
    const mutation = await service.action(f.access, op.resourceId, action, action);
    await getDbClient().run("UPDATE agent_tasks SET agentId=NULL WHERE id=?", [f.task.id]);
    await service.execute(mutation.id);
    expect((await getResource(op.resourceId))?.state).toBe("running");
    expect((await getResource(op.resourceId))?.runningLeaseExpiresAt).toBe(
      prior.runningLeaseExpiresAt,
    );
    expect(await reserved(op.resourceId)).toBe(true);
    const { checkpointCosts } = await import("../be/resources/costs");
    await checkpointCosts(now());
    expect(
      (
        await getDbClient().get<{ total: number }>(
          "SELECT SUM(amountUsd) total FROM resource_costs WHERE resourceId=?",
          [op.resourceId],
        )
      )?.total,
    ).toBeCloseTo(0.001);
  }
});

test("private configuration toggled after admission denies create, resume, and touch but permits cleanup", async () => {
  for (const action of ["create", "resume", "touch"] as const) {
    const f = await fixture();
    const service = f.service();
    const create = await service.create(f.access, f.input());
    let operation = create;
    let state = "error";
    if (action !== "create") {
      await service.execute(create.id);
      if (action === "resume") {
        const pause = await service.action(f.access, create.resourceId, "pause", "pause");
        await service.execute(pause.id);
      }
      state = (await getResource(create.resourceId))!.state;
      time += 1000;
      operation = await service.action(f.access, create.resourceId, action, action);
    }
    let mutations = 0;
    f.adapter.create =
      f.adapter.resume =
      f.adapter.renewLease =
        async () => {
          mutations++;
          throw new Error("forbidden");
        };
    await upsertSwarmConfig({ scope: "global", key: "RESOURCE_PREVIEW_ACCESS", value: "private" });
    reopen();
    await f.service().execute(operation.id);
    expect(mutations).toBe(0);
    expect((await getResource(create.resourceId))?.state).toBe(state);
    expect((await getOperation(operation.id))?.status).toBe("failed");
    const destroy = await service.action(f.access, create.resourceId, "destroy", "cleanup");
    await service.execute(destroy.id);
    expect((await getResource(create.resourceId))?.state).toBe("destroyed");
    await upsertSwarmConfig({ scope: "global", key: "RESOURCE_PREVIEW_ACCESS", value: "public" });
  }
});

test("authoritative absent uncertain create settles after hard deadline, retains estimates, and releases profile", async () => {
  const f = await fixture("browser");
  const service = f.service();
  const profile = await createBrowserProfile({
    name: "uncertain",
    provider: "fake",
    ownerScope: "swarm",
  });
  const op = await service.create(f.access, { ...f.input(), profileId: profile.id });
  let creates = 0,
    lists = 0;
  const create = f.adapter.create.bind(f.adapter);
  f.adapter.create = async () => {
    creates++;
    throw new Error("transport lost");
  };
  const list = f.adapter.listOwned.bind(f.adapter);
  f.adapter.listOwned = async (...args) => {
    lists++;
    return list(...args);
  };
  await service.execute(op.id);
  reopen();
  const reconciler = new ResourceReconciler(f.service());
  for (let i = 0; i < 5; i++) {
    time += 1000;
    await reconciler.tick();
  }
  expect(lists).toBeLessThanOrEqual(2);
  expect((await getOperation(op.id))?.status).toBe("uncertain");
  time += 66000;
  const authoritative = f.adapter.listOwned;
  f.adapter.listOwned = async () => {
    throw new Error("incomplete provider listing");
  };
  await reconciler.tick();
  expect((await getOperation(op.id))?.status).toBe("uncertain");
  expect(await reserved(op.resourceId)).toBe(true);
  f.adapter.listOwned = authoritative;
  const retry = (await getDbClient().get<{ nextAttemptAt: string }>(
    "SELECT nextAttemptAt FROM resource_operations WHERE id=?",
    [op.id],
  ))!;
  expect(Date.parse(retry.nextAttemptAt)).toBeGreaterThan(time);
  time = Date.parse(retry.nextAttemptAt);
  await reconciler.tick();
  expect((await getOperation(op.id))?.status).toBe("failed");
  expect(await reserved(op.resourceId)).toBe(false);
  expect(creates).toBe(1);
  const costs = await getDbClient().get<{ total: number }>(
    "SELECT SUM(amountUsd) total FROM resource_costs WHERE resourceId=?",
    [op.resourceId],
  );
  expect(costs?.total).toBeCloseTo(0.06);
  f.adapter.create = create;
  const next = await service.create(f.access, { ...f.input(), profileId: profile.id });
  await service.execute(next.id);
  expect((await getOperation(next.id))?.status).toBe("succeeded");
});

test("failed resume settles confirmed pause after deadline and permits an explicit retry", async () => {
  const f = await fixture();
  const service = f.service();
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  const pause = await service.action(f.access, op.resourceId, "pause", "pause");
  await service.execute(pause.id);
  const original = f.adapter.resume.bind(f.adapter);
  f.adapter.resume = async () => {
    throw new Error("unresolved resume");
  };
  const resume = await service.action(f.access, op.resourceId, "resume", "resume");
  await service.execute(resume.id);
  await expect(
    service.action(f.access, op.resourceId, "destroy", "unsafe-pending-start"),
  ).rejects.toThrow("uncertain");
  time += 71000;
  reopen();
  await f.service().execute(resume.id);
  expect((await getOperation(resume.id))?.status).toBe("failed");
  expect((await getResource(op.resourceId))?.state).toBe("paused");
  expect(await reserved(op.resourceId)).toBe(false);
  f.adapter.resume = original;
  const retry = await service.action(f.access, op.resourceId, "resume", "retry");
  await service.execute(retry.id);
  expect((await getOperation(retry.id))?.status).toBe("succeeded");
});

test("extendable browser renewal extends its actual deadline while fixed sessions reject renewal truthfully", async () => {
  const f = await fixture("browser");
  const service = f.service();
  f.adapter.traits.maxContinuousMs = 180000;
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "60000" });
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  time += 30000;
  const touch = await service.action(f.access, op.resourceId, "touch", "extend");
  await service.execute(touch.id);
  expect((await getResource(op.resourceId))?.runningLeaseExpiresAt).toBe(
    new Date(time + 60000).toISOString(),
  );
  const data = await getResourcePrivate(op.resourceId);
  if (f.adapter.kind !== "browser") throw new Error("browser required");
  expect(
    (await f.adapter.connection(data!.handle as Parameters<typeof f.adapter.connection>[0]))
      .expiresAt,
  ).toBe(new Date(time + 60000).toISOString());
  const prior = await getResource(op.resourceId);
  f.adapter.traits.leaseRenewal = "fixed";
  await expect(service.action(f.access, op.resourceId, "touch", "fixed")).rejects.toMatchObject({
    code: "unsupported",
  });
  expect(await getResource(op.resourceId)).toEqual(prior);
  time += 60000;
  await new ResourceReconciler(service).tick();
  const reopen = await service.action(f.access, op.resourceId, "resume", "reconnect");
  await service.execute(reopen.id);
  expect((await getResource(op.resourceId))?.generation).toBe(2);
});

test("browser stops at its budget boundary", async () => {
  const f = await fixture("browser");
  await getDbClient().run(
    "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES ('global','',0.001,0,0)",
  );
  const service = f.service();
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  time += 1000;
  await new ResourceReconciler(service).tick();
  expect((await getResource(op.resourceId))?.state).toBe("stopped");
  expect(await reserved(op.resourceId)).toBe(false);
});

test("expired claims cannot install late pause or destroy results after another process settles", async () => {
  for (const action of ["pause", "destroy"] as const) {
    const f = await fixture();
    const service = f.service();
    const create = await service.create(f.access, f.input());
    await service.execute(create.id);
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const called = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const original = f.adapter[action].bind(f.adapter);
    let first = true;
    f.adapter[action] = async (handle, context) => {
      if (first) {
        first = false;
        entered();
        await gate;
      }
      return original(handle, context);
    };
    const op = await service.action(f.access, create.resourceId, action, "late");
    const pending = service.execute(op.id);
    await called;
    time += 31000;
    await f.service().execute(op.id);
    const confirmed = await getResource(create.resourceId);
    release();
    await pending;
    expect(await getResource(create.resourceId)).toEqual(confirmed);
    expect(confirmed?.state).toBe(action === "pause" ? "paused" : "destroyed");
    expect((await getOperation(op.id))?.status).toBe("succeeded");
  }
});

test("swarm capacity serializes concurrent resumes and mixed create across unrelated roots", async () => {
  const f = await fixture();
  const service = f.service();
  const resources: string[] = [];
  for (let i = 0; i < 2; i++) {
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    const pause = await service.action(f.access, op.resourceId, "pause", `pause-${i}`);
    await service.execute(pause.id);
    resources.push(op.resourceId);
  }
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_SWARM_CAP", value: "1" });
  const other = await fixture();
  const results = await Promise.allSettled([
    service.action(f.access, resources[0]!, "resume", "one"),
    f.service().action(f.access, resources[1]!, "resume", "two"),
    other.service().create(other.access, other.input()),
  ]);
  expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
  expect(
    (
      await getDbClient().get<{ n: number }>(
        "SELECT COUNT(*) n FROM resources WHERE liveReservation=1",
      )
    )?.n,
  ).toBe(1);
});

test("confirmed cleanup supersedes interrupted commands without reviving the operation", async () => {
  const f = await fixture();
  const service = f.service();
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  const touch = await insertResourceOperation({
    resourceId: op.resourceId,
    generation: 1,
    kind: "exec",
    idempotencyKey: "interrupted-command",
  });
  await service.execute(touch.id);
  expect((await getOperation(touch.id))?.status).toBe("uncertain");
  const destroy = await service.action(f.access, op.resourceId, "destroy", "destroy");
  await service.execute(destroy.id);
  expect((await getOperation(touch.id))?.status).toBe("failed");
  time += 71000;
  await service.execute(touch.id);
  expect((await getResource(op.resourceId))?.state).toBe("destroyed");
});

test("interrupted refresh cannot replay or overwrite a later generation after file reopen", async () => {
  const f = await fixture();
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  const refresh = await insertResourceOperation({
    resourceId: create.resourceId,
    generation: 1,
    kind: "refresh",
    idempotencyKey: "refresh",
  });
  await claimOperation(refresh.id, now(), "lost-refresh");
  time += 31000;
  reopen();
  await service.execute(refresh.id);
  expect((await getOperation(refresh.id))?.status).toBe("uncertain");
  await getDbClient().run("UPDATE resources SET generation=2 WHERE id=?", [create.resourceId]);
  time += 10000;
  const before = await getResource(create.resourceId);
  await service.execute(refresh.id);
  expect((await getOperation(refresh.id))?.status).toBe("failed");
  expect(await getResource(create.resourceId)).toEqual(before);
});

test("uncertain creation blocks user cleanup until the lost session is recovered", async () => {
  for (const action of ["pause", "stop", "destroy"] as const) {
    const f = await fixture(action === "stop" ? "browser" : "sandbox");
    const service = f.service();
    const original = f.adapter.create.bind(f.adapter);
    let complete!: () => ReturnType<typeof original>;
    f.adapter.create = async (input, context) => {
      complete = () => original(input, context);
      throw new Error("transport lost before creation response");
    };
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    time += 1000;
    await expect(service.action(f.access, op.resourceId, action, "cleanup")).rejects.toThrow(
      "uncertain",
    );
    expect(await reserved(op.resourceId)).toBe(true);
    await complete();
    time += 5000;
    await service.execute(op.id);
    expect((await getOperation(op.id))?.status).toBe("succeeded");
    const cleanup = await service.action(f.access, op.resourceId, action, "cleanup");
    await service.execute(cleanup.id);
    expect((await getOperation(cleanup.id))?.status).toBe("succeeded");
    expect(await reserved(op.resourceId)).toBe(false);
  }
});

test("ownership discovery detects live sessions behind terminal or unreserved local records", async () => {
  const f = await fixture();
  const service = f.service();
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  const reconciler = new ResourceReconciler(service);
  for (const state of ["running", "destroyed"]) {
    await getDbClient().run("UPDATE resources SET state=?,liveReservation=0 WHERE id=?", [
      state,
      op.resourceId,
    ]);
    expect(await reconciler.discoverOwned()).toEqual([
      { resourceId: op.resourceId, generation: 1 },
    ]);
  }
  // A genuinely paused, retained sandbox is not an orphan.
  const data = await getResourcePrivate(op.resourceId);
  await f.adapter.pause(data!.handle as Parameters<typeof f.adapter.pause>[0]);
  await getDbClient().run("UPDATE resources SET state='paused' WHERE id=?", [op.resourceId]);
  expect(await reconciler.discoverOwned()).toEqual([]);
});

test("renewal recovery cannot use the old running lease as proof of an extension", async () => {
  for (const action of ["touch", "resume"] as const) {
    for (const applied of [false, true]) {
      const f = await fixture();
      f.adapter.traits.maxContinuousMs = 180000;
      await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "60000" });
      const service = f.service();
      const create = await service.create(f.access, f.input());
      await service.execute(create.id);
      const original = f.adapter.renewLease.bind(f.adapter);
      f.adapter.renewLease = async (...args) => {
        if (applied) await original(...args);
        throw new Error("renewal response lost");
      };
      time += 30000;
      const renewal = await service.action(f.access, create.resourceId, action, "renew");
      await service.execute(renewal.id);
      time += 6000;
      await service.execute(renewal.id);
      expect((await getOperation(renewal.id))?.status).toBe("uncertain");
      time += 35000;
      await service.execute(renewal.id);
      if (applied) {
        expect((await getOperation(renewal.id))?.status).toBe("succeeded");
      } else {
        expect((await getOperation(renewal.id))?.status).toBe("failed");
        expect(await reserved(create.resourceId)).toBe(false);
        time += 30000;
        await service.execute(renewal.id);
        expect((await getOperation(renewal.id))?.status).toBe("failed");
        expect((await getResource(create.resourceId))?.state).toBe("paused");
      }
    }
  }
});

test("compensated reaper attempts retry with fresh keys and recover a transient factory failure", async () => {
  const f = await fixture();
  const service = f.service();
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    ids.push(op.resourceId);
  }
  let broken = true;
  const retrying = new ResourceService({
    ownerId: "swarm-test",
    now,
    provider: async () => {
      if (broken) throw new Error("transient factory failure");
      return f.adapter;
    },
  });
  time += 61000;
  for (const id of ids) {
    const op = (await retrying.cleanup((await getResource(id))!))!;
    await retrying.execute(op.id);
    expect((await getOperation(op.id))?.status).toBe("failed");
    expect((await getResource(id))?.state).toBe("running");
  }
  broken = false;
  time += 5000;
  const reconciler = new ResourceReconciler(retrying);
  await reconciler.tick();
  await reconciler.tick();
  for (const id of ids) {
    expect((await getResource(id))?.state).toBe("paused");
    expect(await reserved(id)).toBe(false);
  }
});

test("one failing operation or cleanup does not block the rest of a reconciliation page", async () => {
  const f = await fixture();
  const service = f.service();
  const first = await service.create(f.access, f.input());
  const second = await service.create(f.access, f.input());
  const execute = service.execute.bind(service);
  service.execute = async (id) => {
    if (id === first.id) throw new Error("one operation failed");
    await execute(id);
  };
  const reconciler = new ResourceReconciler(service);
  await reconciler.tick();
  expect((await getOperation(second.id))?.status).toBe("succeeded");
  service.execute = execute;
  await reconciler.tick();
  expect((await getOperation(first.id))?.status).toBe("succeeded");
  time += 61000;
  const cleanup = service.cleanup.bind(service);
  service.cleanup = async (resource) => {
    if (resource.id === first.resourceId) throw new Error("one resource failed");
    return cleanup(resource);
  };
  await reconciler.tick();
  expect((await getResource(second.resourceId))?.state).toBe("paused");
  service.cleanup = cleanup;
  await reconciler.tick();
  expect((await getResource(first.resourceId))?.state).toBe("paused");
});

test("shutdown after the mutation marker permits the committed dispatch and its confirmation", async () => {
  const f = await fixture();
  const service = f.service();
  const op = await service.create(f.access, f.input());
  const call = service.call.bind(service);
  service.call = <T>(
    run: (context: ProviderOperationContext) => Promise<T>,
    deadline?: string,
    dispatched?: boolean,
  ) => {
    service.shutdown();
    return call(run, deadline, dispatched);
  };
  await service.execute(op.id);
  expect(f.calls()).toBe(1);
  expect((await getOperation(op.id))?.status).toBe("succeeded");
  await expect(service.create(f.access, f.input())).rejects.toThrow("shutdown");
});

test("authoritative absence destroys a missing sandbox instead of offering an impossible resume", async () => {
  const f = await fixture();
  const service = f.service();
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  const data = await getResourcePrivate(op.resourceId);
  await f.adapter.destroy(data!.handle as Parameters<typeof f.adapter.destroy>[0]);
  await getDbClient().run("UPDATE resources SET providerHandle=NULL WHERE id=?", [op.resourceId]);
  const pause = await service.action(f.access, op.resourceId, "pause", "absent");
  await service.execute(pause.id);
  expect((await getResource(op.resourceId))?.state).toBe("destroyed");
  expect(await reserved(op.resourceId)).toBe(false);
  await expect(service.action(f.access, op.resourceId, "resume", "impossible")).rejects.toThrow(
    "destroyed",
  );
});

test("fake observation and browser stop honor aborted and expired operation contexts", async () => {
  const f = await fixture("browser");
  const service = f.service();
  const op = await service.create(f.access, f.input());
  await service.execute(op.id);
  if (f.adapter.kind !== "browser") throw new Error("browser required");
  const data = await getResourcePrivate(op.resourceId);
  const handle = data!.handle as Parameters<typeof f.adapter.stop>[0];
  const controller = new AbortController();
  controller.abort();
  for (const context of [
    { signal: controller.signal, deadlineAt: new Date(time + 5000).toISOString() },
    { signal: new AbortController().signal, deadlineAt: now().toISOString() },
  ]) {
    await expect(f.adapter.status(handle, context)).rejects.toMatchObject({ code: "deadline" });
    await expect(f.adapter.listOwned("swarm-test", context)).rejects.toMatchObject({
      code: "deadline",
    });
    await expect(f.adapter.stop(handle, context)).rejects.toMatchObject({ code: "deadline" });
  }
  expect(await f.adapter.status(handle)).toBe("running");
});

test("reaper rechecks activity after an earlier page item renews another resource", async () => {
  const f = await fixture();
  const service = f.service();
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_IDLE_MS", value: "1000" });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    ids.push(op.resourceId);
  }
  ids.sort();
  const pause = f.adapter.pause.bind(f.adapter);
  f.adapter.pause = async (handle, context) => {
    if (handle.resourceId === ids[0]) {
      const touch = await service.action(f.access, ids[1]!, "touch", "renew-during-page");
      await service.execute(touch.id);
      expect((await getOperation(touch.id))?.status).toBe("succeeded");
    }
    return pause(handle, context);
  };
  time += 2000;
  await new ResourceReconciler(service).tick();
  expect((await getResource(ids[0]!))?.state).toBe("paused");
  expect((await getResource(ids[1]!))?.state).toBe("running");
  expect((await getResource(ids[1]!))?.lastActivityAt).toBe(now().toISOString());
});

test("reaper recomputes cleanup kind when expiry passes during an earlier page item", async () => {
  const f = await fixture();
  const service = f.service();
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_IDLE_MS", value: "1000" });
  const ids: string[] = [];
  for (let i = 0; i < 2; i++) {
    const op = await service.create(f.access, f.input());
    await service.execute(op.id);
    ids.push(op.resourceId);
  }
  ids.sort();
  await getDbClient().run("UPDATE resources SET expiresAt=? WHERE id=?", [
    new Date(time + 3000).toISOString(),
    ids[1]!,
  ]);
  const pause = f.adapter.pause.bind(f.adapter);
  f.adapter.pause = async (handle, context) => {
    if (handle.resourceId === ids[0]) time += 2000;
    return pause(handle, context);
  };
  time += 2000;
  await new ResourceReconciler(service).tick();
  expect((await getResource(ids[1]!))?.state).toBe("destroyed");
});

test("persistent pre-dispatch cleanup failures back off durably across service and database restarts", async () => {
  const f = await fixture();
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  let broken = true;
  const makeReconciler = () =>
    new ResourceReconciler(
      new ResourceService({
        ownerId: "swarm-test",
        now,
        provider: async () => {
          if (broken) throw new Error("persistent factory failure");
          return f.adapter;
        },
      }),
    );
  let reconciler = makeReconciler();
  const start = time + 61000;
  for (let tick = 0; tick < 12; tick++) {
    time = start + tick * 5000;
    if (tick === 4 || tick === 8) {
      reopen();
      reconciler = makeReconciler();
    }
    await reconciler.tick();
  }
  const attempts = await getDbClient().get<{ n: number }>(
    "SELECT COUNT(*) n FROM resource_operations WHERE resourceId=? AND kind='pause'",
    [create.resourceId],
  );
  expect(attempts?.n).toBe(4);
  expect(await reserved(create.resourceId)).toBe(true);
  broken = false;
  time = start + 75000;
  await reconciler.tick();
  expect((await getResource(create.resourceId))?.state).toBe("paused");
  expect(await reserved(create.resourceId)).toBe(false);
});

test("resume rejects an expired running lease before admission and succeeds after reaper settlement", async () => {
  const f = await fixture();
  f.adapter.traits.maxContinuousMs = 180000;
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "10000" });
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  let renewals = 0;
  const renew = f.adapter.renewLease.bind(f.adapter);
  f.adapter.renewLease = async (...args) => {
    renewals++;
    return renew(...args);
  };
  time += 11000;
  await expect(service.action(f.access, create.resourceId, "resume", "expired")).rejects.toThrow(
    "lease",
  );
  expect(renewals).toBe(0);
  expect(
    await getDbClient().query("SELECT id FROM resource_operations WHERE resourceId=?", [
      create.resourceId,
    ]),
  ).toHaveLength(1);
  await new ResourceReconciler(service).tick();
  expect((await getResource(create.resourceId))?.state).toBe("paused");
  const resume = await service.action(f.access, create.resourceId, "resume", "after-settlement");
  await service.execute(resume.id);
  expect((await getOperation(resume.id))?.status).toBe("succeeded");
  const costs = await getDbClient().get<{ total: number }>(
    "SELECT SUM(amountUsd) total FROM resource_costs WHERE resourceId=?",
    [create.resourceId],
  );
  expect(costs?.total).toBeCloseTo(0.01);
  time += 9000;
  const queuedRenewal = await service.action(
    f.access,
    create.resourceId,
    "touch",
    "queued-before-expiry",
  );
  time += 2000;
  await service.execute(queuedRenewal.id);
  expect((await getOperation(queuedRenewal.id))?.status).toBe("failed");
  expect(renewals).toBe(0);
  await new ResourceReconciler(service).tick();
  expect((await getResource(create.resourceId))?.state).toBe("paused");
  expect(
    (
      await getDbClient().get<{ total: number }>(
        "SELECT SUM(amountUsd) total FROM resource_costs WHERE resourceId=?",
        [create.resourceId],
      )
    )?.total,
  ).toBeCloseTo(0.02);
});

test("invalid admission configuration does not prevent cleanup of existing resources", async () => {
  const f = await fixture();
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  process.env.RESOURCE_TREE_CAP = "invalid";
  process.env.RESOURCE_IDLE_MS = "invalid";
  try {
    await expect(service.create(f.access, f.input())).rejects.toThrow("RESOURCE_TREE_CAP");
    time += 61000;
    await new ResourceReconciler(service).tick();
    expect((await getResource(create.resourceId))?.state).toBe("paused");
  } finally {
    delete process.env.RESOURCE_TREE_CAP;
    delete process.env.RESOURCE_IDLE_MS;
  }
});

test("missing compensation metadata cannot release a previously running resource", async () => {
  const f = await fixture();
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  const pause = await insertResourceOperation({
    resourceId: create.resourceId,
    generation: 1,
    kind: "pause",
    idempotencyKey: "missing-snapshot",
  });
  const broken = new ResourceService({
    ownerId: "swarm-test",
    now,
    provider: async () => {
      throw new Error("factory unavailable");
    },
  });
  await broken.execute(pause.id);
  expect((await getOperation(pause.id))?.status).toBe("failed");
  expect(await reserved(create.resourceId)).toBe(true);
  time += 61000;
  await new ResourceReconciler(service).tick();
  expect((await getResource(create.resourceId))?.state).toBe("paused");
  expect(await reserved(create.resourceId)).toBe(false);
});

test("renewal recovery settles authoritative absence after the previous lease deadline", async () => {
  const f = await fixture();
  f.adapter.traits.maxContinuousMs = 180000;
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "60000" });
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  f.adapter.renewLease = async () => {
    throw new Error("lost renewal response");
  };
  time += 30000;
  const renewal = await service.action(
    f.access,
    create.resourceId,
    "touch",
    "renew-before-disappearance",
  );
  await service.execute(renewal.id);
  time += 41000;
  const data = await getResourcePrivate(create.resourceId);
  await f.adapter.destroy(data!.handle as Parameters<typeof f.adapter.destroy>[0]);
  await service.execute(renewal.id);
  expect((await getOperation(renewal.id))?.status).toBe("failed");
  expect((await getResource(create.resourceId))?.state).toBe("destroyed");
  expect(await reserved(create.resourceId)).toBe(false);
});

test("known uncertain renewals permit terminal cleanup without releasing capacity early or reviving an old handle", async () => {
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_SWARM_CAP", value: "1" });
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "60000" });
  for (const kind of ["sandbox", "browser"] as const) {
    const f = await fixture(kind);
    f.adapter.traits.maxContinuousMs = 180000;
    const service = f.service();
    const create = await service.create(f.access, f.input());
    await service.execute(create.id);
    const old = (await getResourcePrivate(create.resourceId))!.handle as Parameters<
      typeof f.adapter.renewLease
    >[0];
    const renew = f.adapter.renewLease.bind(f.adapter);
    let lateRenewal!: () => ReturnType<typeof renew>;
    f.adapter.renewLease = async (...args) => {
      lateRenewal = () => renew(...args);
      throw new Error("renewal response lost");
    };
    time += 30000;
    const renewal = await service.action(f.access, create.resourceId, "touch", "lost-renewal");
    await service.execute(renewal.id);
    expect((await getOperation(renewal.id))?.status).toBe("uncertain");
    const action = kind === "browser" ? "stop" : "destroy";
    if (kind === "sandbox")
      await expect(
        service.action(f.access, create.resourceId, "pause", "unsafe-pause"),
      ).rejects.toThrow("uncertain");
    await getDbClient().run("UPDATE agent_tasks SET agentId=NULL WHERE id=?", [f.task.id]);
    await expect(
      service.action(f.access, create.resourceId, action, "unauthorized"),
    ).rejects.toThrow("denied");
    await getDbClient().run("UPDATE agent_tasks SET agentId=? WHERE id=?", [f.agent.id, f.task.id]);

    // A missing or changed current handle is not proof that termination covers the renewal.
    const stored = (await getDbClient().get<{ providerHandle: string }>(
      "SELECT providerHandle FROM resources WHERE id=?",
      [create.resourceId],
    ))!;
    for (const handle of [null, sealJson({ ...old, externalId: "different-handle" })]) {
      await getDbClient().run("UPDATE resources SET providerHandle=? WHERE id=?", [
        handle,
        create.resourceId,
      ]);
      await expect(
        service.action(f.access, create.resourceId, action, "unproven-handle"),
      ).rejects.toThrow("uncertain");
    }
    await getDbClient().run("UPDATE resources SET providerHandle=? WHERE id=?", [
      stored.providerHandle,
      create.resourceId,
    ]);

    let broken = true;
    const terminate =
      f.adapter.kind === "browser"
        ? f.adapter.stop.bind(f.adapter)
        : f.adapter.destroy.bind(f.adapter);
    const wrapped = async (...args: Parameters<typeof terminate>) => {
      if (broken) {
        // Cover both no effect and a successful stop whose response was lost.
        if (kind === "browser") await terminate(...args);
        throw new Error("termination response lost");
      }
      return terminate(...args);
    };
    if (f.adapter.kind === "browser") f.adapter.stop = wrapped;
    else f.adapter.destroy = wrapped;
    time += 1000;
    const failed = await service.action(f.access, create.resourceId, action, "failed-termination");
    await service.execute(failed.id);
    expect((await getOperation(failed.id))?.status).toBe("uncertain");
    expect(await reserved(create.resourceId)).toBe(true);
    expect((await getOperation(renewal.id))?.status).toBe("uncertain");
    broken = false;
    const success = await service.action(
      f.access,
      create.resourceId,
      action,
      "confirmed-termination",
    );
    await service.execute(success.id);
    expect((await getOperation(success.id))?.status).toBe("succeeded");
    expect((await getOperation(renewal.id))?.status).toBe("failed");
    expect((await getOperation(failed.id))?.status).toBe("failed");
    expect(await reserved(create.resourceId)).toBe(false);

    // Reopen browsers at a new generation; destroyed sandboxes require a new resource.
    const next =
      kind === "browser"
        ? await service.action(f.access, create.resourceId, "resume", "reopen")
        : await service.create(f.access, f.input());
    await service.execute(next.id);
    expect((await getOperation(next.id))?.status).toBe("succeeded");
    await expect(lateRenewal()).rejects.toMatchObject({ code: "conflict" });
    expect(await f.adapter.status(old)).toBe(kind === "browser" ? "stopped" : "destroyed");
    expect((await getResource(next.resourceId))?.state).toBe("running");
    if (kind === "browser") expect((await getResource(next.resourceId))?.generation).toBe(2);
    const finish = await service.action(f.access, next.resourceId, "destroy", "finish-test");
    await service.execute(finish.id);
  }
});

test("slow provider selection occurs outside the write transaction and revalidates authorization", async () => {
  const f = await fixture();
  const service = f.service();
  const create = await service.create(f.access, f.input());
  await service.execute(create.id);
  const pause = await service.action(f.access, create.resourceId, "pause", "pause");
  await service.execute(pause.id);
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const called = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const slow = new ResourceService({
    ownerId: "swarm-test",
    now,
    provider: async () => {
      entered();
      await gate;
      return f.adapter;
    },
  });
  const result = slow.action(f.access, create.resourceId, "resume", "slow");
  await called;
  await getDbClient().transaction(async (tx) => {
    await tx.run("UPDATE agent_tasks SET agentId=NULL WHERE id=?", [f.task.id]);
  });
  release();
  await expect(result).rejects.toThrow("denied");
  expect((await getResource(create.resourceId))?.state).toBe("paused");
});
