import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { canClaim } from "../be/budget-admission";
import {
  closeDb,
  createAgent,
  createTaskExtended,
  createUser,
  getDailySpendForAgent,
  getDailySpendForUser,
  getDailySpendGlobal,
  getDbClient,
  getSessionCostSummary,
  initDb,
  UNATTRIBUTED_USER_ID,
  upsertSwarmConfig,
} from "../be/db";
import { resolveResourceAccess } from "../be/resources/access";
import { resourceConfig } from "../be/resources/config";
import { checkpointCosts, reportResourceCost } from "../be/resources/costs";
import { getResource } from "../be/resources/db";
import { ResourceService } from "../be/resources/service";
import { validateConfigValue } from "../be/swarm-config-guard";
import { createFakeResourceProvider } from "../resource-providers/fake";
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
const path = `./test-resources-costs-${crypto.randomUUID()}.sqlite`;
let time: number;
const now = () => new Date(time);
beforeEach(async () => {
  closeDb();
  await removeResourceTestDb(path);
  initDb(path);
  time = Date.parse("2026-11-08T23:59:30.000Z");
});
afterEach(async () => {
  closeDb();
  await removeResourceTestDb(path);
  delete process.env.RESOURCE_TREE_CAP;
});
async function fixture() {
  const agent = await createAgent({ name: "cost worker", isLead: false, status: "idle" });
  const user = await createUser({ name: "cost owner" });
  const task = await createTaskExtended("cost source", {
    agentId: agent.id,
    requestedByUserId: user.id,
  });
  const access = (await resolveResourceAccess({ kind: "agent", agentId: agent.id }, task.id))!;
  const adapter = createFakeResourceProvider("sandbox", now);
  adapter.traits.maxContinuousMs = 180_000;
  const service = new ResourceService({
    ownerId: "cost-swarm",
    now,
    provider: async () => adapter,
  });
  const op = await service.create(access, {
    kind: "sandbox",
    provider: "fake",
    key: "cost-create",
  });
  await service.execute(op.id);
  return { agent, user, task, access, adapter, service, id: op.resourceId };
}
test("cost checkpoints split UTC midnight, survive completed/deleted tasks and DB reopen, and remain idempotent", async () => {
  const f = await fixture();
  time += 30_000;
  await getDbClient().run("UPDATE agent_tasks SET status='completed' WHERE id=?", [f.task.id]);
  await Promise.all(Array.from({ length: 8 }, () => checkpointCosts(now())));
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.03);
  time += 30_000;
  await checkpointCosts(now());
  await getDbClient().run("DELETE FROM agent_tasks WHERE id=?", [f.task.id]);
  const globals = globalThis as typeof globalThis & { __testMigrationTemplate?: Uint8Array };
  const saved = globals.__testMigrationTemplate;
  globals.__testMigrationTemplate = undefined;
  closeDb();
  try {
    initDb(path);
  } finally {
    globals.__testMigrationTemplate = saved;
  }
  await checkpointCosts(now());
  expect(await getDailySpendForAgent(f.agent.id, "2026-11-09", now())).toBeCloseTo(0.03);
  expect(await getDailySpendForUser(f.user.id, "2026-11-09", now())).toBeCloseTo(0.03);
  const rows = await getDbClient().query<{ intervalStart: string; intervalEnd: string }>(
    "SELECT * FROM resource_costs",
  );
  expect(rows).toHaveLength(2);
  for (const row of rows)
    expect(row.intervalStart.slice(0, 10)).toBe(
      new Date(Date.parse(row.intervalEnd) - 1).toISOString().slice(0, 10),
    );
  const summary = await getSessionCostSummary({ userId: f.user.id });
  expect(summary.totals.totalCostUsd).toBe(0);
  expect(summary.resourceCosts.estimatedCostUsd).toBeCloseTo(0.06);
  expect(summary.combinedCostUsd).toBeCloseTo(0.06);
  expect(summary.byCredential).toEqual([]);
});
test("human-free resource Usage is unattributed without changing immutable budget attribution", async () => {
  const f = await fixture();
  time += 10000;
  await checkpointCosts(now());
  await getDbClient().run("UPDATE agent_tasks SET isHumanFree=1 WHERE id=?", [f.task.id]);
  expect((await getSessionCostSummary({ userId: f.user.id })).resourceCosts.totalCostUsd).toBe(0);
  expect(
    (await getSessionCostSummary({ userId: UNATTRIBUTED_USER_ID })).resourceCosts.totalCostUsd,
  ).toBeCloseTo(0.01);
  expect((await getSessionCostSummary({})).resourceCosts.totalCostUsd).toBeCloseTo(0.01);
  expect(await getDailySpendForUser(f.user.id, "2026-11-08", now())).toBeCloseTo(0.01);
  await getDbClient().run("UPDATE agent_tasks SET isHumanFree=0 WHERE id=?", [f.task.id]);
  expect(
    (await getSessionCostSummary({ userId: f.user.id })).resourceCosts.totalCostUsd,
  ).toBeCloseTo(0.01);
  expect(
    (await getSessionCostSummary({ userId: UNATTRIBUTED_USER_ID })).resourceCosts.totalCostUsd,
  ).toBe(0);
});

test("provider reports replace overlapping estimates, preserve tails, and never add both charge sources", async () => {
  time = Date.parse("2026-11-08T12:00:00.000Z");
  const f = await fixture();
  time += 60_000;
  await checkpointCosts(now());
  const report = {
    resourceId: f.id,
    generation: 1,
    dimension: "runtime",
    start: "2026-11-08T12:00:15.000Z",
    end: "2026-11-08T12:00:45.000Z",
    amountUsd: 0.1,
  };
  await Promise.all([reportResourceCost(report, now()), reportResourceCost(report, now())]);
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.13);
  const summary = await getSessionCostSummary({});
  expect(summary.resourceCosts.providerCostUsd).toBeCloseTo(0.1);
  expect(summary.resourceCosts.estimatedCostUsd).toBeCloseTo(0.03);
  await expect(
    reportResourceCost({ ...report, start: "2026-11-08T12:00:30.000Z" }, now()),
  ).rejects.toThrow("overlap");
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.13);
});
test("pure task admission counts accrued resources globally, by agent, and by canonical requester", async () => {
  time = Date.parse("2026-11-08T12:00:00.000Z");
  const f = await fixture();
  time += 20_000;
  for (const [scope, id] of [
    ["global", ""],
    ["agent", f.agent.id],
    ["user", f.user.id],
  ] as const) {
    await getDbClient().run("DELETE FROM budgets");
    await getDbClient().run(
      "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES (?,?,0.01,0,0)",
      [scope, id],
    );
    const result = await canClaim(f.agent.id, now(), f.user.id);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.cause).toBe(scope);
  }
  expect(await getDbClient().query("SELECT * FROM resource_costs")).toHaveLength(0);
});
test("rate snapshots and resource attribution cannot change after task reassignment", async () => {
  time = Date.parse("2026-11-08T12:00:00.000Z");
  const f = await fixture();
  time += 10_000;
  await checkpointCosts(now());
  const other = await createUser({ name: "new requester" });
  await getDbClient().run("UPDATE agent_tasks SET requestedByUserId=? WHERE id=?", [
    other.id,
    f.task.id,
  ]);
  time += 10_000;
  await checkpointCosts(now());
  expect(await getDailySpendForUser(f.user.id, "2026-11-08", now())).toBeCloseTo(0.02);
  expect(await getDailySpendForUser(other.id, "2026-11-08", now())).toBe(0);
  await expect(
    getDbClient().run("UPDATE resources SET sourceTaskId=? WHERE id=?", [
      crypto.randomUUID(),
      f.id,
    ]),
  ).rejects.toThrow("immutable");
  const row = await getDbClient().get<{ rateEffectiveAt: string; rateUsdPerMs: number }>(
    "SELECT * FROM resource_costs LIMIT 1",
  );
  expect(row).toMatchObject({
    rateEffectiveAt: "2026-01-01T00:00:00.000Z",
    rateUsdPerMs: 0.000001,
  });
  expect((await getResource(f.id))?.requestedByUserId).toBe(f.user.id);
});
test("renewal cannot shorten an existing lease reservation when limits or budget shrink", async () => {
  time = Date.parse("2026-11-08T12:00:00.000Z");
  const f = await fixture();
  const before = await getResource(f.id);
  time += 1000;
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "10000" });
  await expect(f.service.action(f.access, f.id, "touch", "shorter-config")).rejects.toThrow(
    "existing lease",
  );
  expect(await getResource(f.id)).toEqual(before);
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "1800000" });
  await getDbClient().run(
    "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES ('global','',0.01,0,0)",
  );
  await expect(f.service.action(f.access, f.id, "resume", "shorter-budget")).rejects.toThrow(
    "existing lease",
  );
  expect(await getResource(f.id)).toEqual(before);
  expect(
    await getDbClient().query("SELECT id FROM resource_operations WHERE resourceId=?", [f.id]),
  ).toHaveLength(1);
  const billing = await getDbClient().get<{ leaseEndsAt: string; billableEndsAt: string }>(
    "SELECT leaseEndsAt,billableEndsAt FROM resource_billing WHERE resourceId=?",
    [f.id],
  );
  expect(billing?.leaseEndsAt).toBe(before?.runningLeaseExpiresAt);
  expect(billing?.billableEndsAt).toBe(before?.runningLeaseExpiresAt);
});

test("stored resource settings override env and validate bounds without storing credentials in the catalog", async () => {
  process.env.RESOURCE_TREE_CAP = "8";
  expect((await resourceConfig()).RESOURCE_TREE_CAP).toBe(8);
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_TREE_CAP", value: "2" });
  expect((await resourceConfig()).RESOURCE_TREE_CAP).toBe(2);
  for (const value of ["0", "-1", "1001", "NaN", "Infinity", "1.2"])
    expect(validateConfigValue("RESOURCE_TREE_CAP", value)).not.toBe(null);
  expect(validateConfigValue("RESOURCE_PREVIEW_ACCESS", "private")).toBe(null);
  expect(validateConfigValue("RESOURCE_PREVIEW_ACCESS", "other")).not.toBe(null);
});

test("late provider reports split an equivalent period across UTC budget days", async () => {
  const f = await fixture();
  time = Date.parse("2026-11-09T00:00:30.000Z");
  await reportResourceCost(
    {
      resourceId: f.id,
      generation: 1,
      dimension: "runtime",
      start: "2026-11-08T23:59:45.000Z",
      end: "2026-11-09T00:00:15.000Z",
      amountUsd: 0.06,
    },
    now(),
  );
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.045);
  expect(await getDailySpendGlobal("2026-11-09", now())).toBeCloseTo(0.045);
  const summary = await getSessionCostSummary({});
  expect(summary.resourceCosts.estimatedCostUsd).toBeCloseTo(0.03);
  expect(summary.resourceCosts.providerCostUsd).toBeCloseTo(0.06);
});

test("the default lease crosses midnight and estimates split once without re-admission", async () => {
  expect((await resourceConfig()).RESOURCE_LEASE_MS).toBe(1800000);
  time = Date.parse("2026-11-08T23:59:59.500Z");
  const f = await fixture();
  const lease = (await getResource(f.id))!.runningLeaseExpiresAt!;
  expect(Date.parse(lease) - time).toBe(180000);
  time += 1500;
  await checkpointCosts(now());
  await checkpointCosts(now());
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.0005);
  expect(await getDailySpendGlobal("2026-11-09", now())).toBeCloseTo(0.001);
  expect(await getDbClient().query("SELECT * FROM resource_costs")).toHaveLength(2);
  expect((await getResource(f.id))?.state).toBe("running");
});

test("next-day budgets include other admitted future leases and shorten the new lease", async () => {
  time = Date.parse("2026-11-08T23:59:59.500Z");
  const f = await fixture();
  // The first lease already reserves 0.1795 for tomorrow.
  await getDbClient().run(
    "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES ('global','',0.18,0,0)",
  );
  const op = await f.service.create(f.access, { kind: "sandbox", provider: "fake", key: "second" });
  expect(
    Date.parse((await getResource(op.resourceId))!.runningLeaseExpiresAt!) - time,
  ).toBeGreaterThanOrEqual(999);
  expect(
    Date.parse((await getResource(op.resourceId))!.runningLeaseExpiresAt!) - time,
  ).toBeLessThanOrEqual(1000);
  // Reserving tomorrow does not charge queued resources today.
  time += 100;
  await checkpointCosts(now());
  expect(
    await getDbClient().query("SELECT * FROM resource_costs WHERE resourceId=?", [op.resourceId]),
  ).toHaveLength(0);
});

test("denied renewal preserves the previous lease, state, and billing snapshot", async () => {
  time = Date.parse("2026-11-08T12:00:00.000Z");
  const f = await fixture();
  const before = await getResource(f.id);
  const billing = await getDbClient().query("SELECT * FROM resource_billing WHERE resourceId=?", [
    f.id,
  ]);
  await getDbClient().run(
    "INSERT INTO budgets(scope,scope_id,daily_budget_usd,createdAt,lastUpdatedAt) VALUES ('global','',0,0,0)",
  );
  await expect(f.service.action(f.access, f.id, "touch", "denied")).rejects.toThrow("budget");
  expect(await getResource(f.id)).toEqual(before);
  expect(
    await getDbClient().query("SELECT * FROM resource_billing WHERE resourceId=?", [f.id]),
  ).toEqual(billing);
});

test("a queued renewal reserves future budget without billing past the actual provider deadline", async () => {
  time = Date.parse("2026-11-08T12:00:00.000Z");
  await upsertSwarmConfig({ scope: "global", key: "RESOURCE_LEASE_MS", value: "60000" });
  const f = await fixture();
  time += 30000;
  const touch = await f.service.action(f.access, f.id, "touch", "queued-renewal");
  time += 40000;
  await checkpointCosts(now());
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.06);
  // An authorization change compensates the proposed lease without replaying charges.
  await getDbClient().run("UPDATE agent_tasks SET agentId=NULL WHERE id=?", [f.task.id]);
  await f.service.execute(touch.id);
  await checkpointCosts(now());
  expect(await getDailySpendGlobal("2026-11-08", now())).toBeCloseTo(0.06);
});
