import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import {
  closeDb,
  createWorkflow,
  getDb,
  getScheduledTaskByName,
  getScheduledTasks,
  initDb,
  listWorkflows,
  upsertSwarmConfig,
} from "../be/db";
import { getScript, upsertScriptByName } from "../be/scripts/db";
import { buildSeeders, runSeeder, SEEDERS } from "../be/seed";
import { schedulesSeeder } from "../be/seed/schedules-seeder";
import { workflowsSeeder } from "../be/seed/workflows-seeder";
import { scriptsSeeder } from "../be/seed-scripts";
import { CHILD_PROCESS_TEST_BUDGET_MS, expectChildOk, runChild } from "./test-proc";

const TEST_DB_PATH = "./test-seed-registry.sqlite";

const SEED_TOGGLE_KEYS = [
  "SEED_SCRIPTS_ENABLED",
  "SEED_SKILLS_ENABLED",
  "SEED_WORKFLOWS_ENABLED",
  "SEED_SCHEDULES_ENABLED",
] as const;

async function seedUpdateCheckTarget(): Promise<void> {
  await upsertScriptByName({
    name: "swarm-update-check",
    scope: "global",
    scopeId: null,
    source: "export default async function main() { return {}; }",
    description: "external stand-in",
    intent: "seed registry target fixture",
    signatureJson: "{}",
    fsMode: "none",
    agentId: null,
    isScratch: false,
    typeChecked: true,
  });
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

const ORIGINAL_TOGGLES = Object.fromEntries(
  SEED_TOGGLE_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof SEED_TOGGLE_KEYS)[number], string | undefined>;

beforeEach(async () => {
  for (const key of SEED_TOGGLE_KEYS) delete process.env[key];
  await removeDbFiles();
  initDb(TEST_DB_PATH);
});

afterEach(async () => {
  closeDb();
  await removeDbFiles();
  for (const key of SEED_TOGGLE_KEYS) {
    const original = ORIGINAL_TOGGLES[key];
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

describe("seeder registry", () => {
  test("registers workflows before schedules", () => {
    expect(SEEDERS.map((seeder) => seeder.kind)).toEqual([
      "agent-fs-provision",
      "script",
      "skill",
      "workflow",
      "schedule",
    ]);
  });

  test("the bundled catalogs include every workflow and schedule template", async () => {
    for (const [kind, seeder] of [
      ["workflows", workflowsSeeder],
      ["schedules", schedulesSeeder],
    ] as const) {
      const catalogNames: string[] = [];
      const catalogDir = `${import.meta.dir}/../../templates/${kind}`;
      for await (const path of new Bun.Glob("*/config.json").scan(catalogDir)) {
        const config = await Bun.file(`${catalogDir}/${path}`).json();
        catalogNames.push(config.name);
      }
      expect((await seeder.items()).map((item) => item.key).sort()).toEqual(catalogNames.sort());
    }
  });

  test("seeds all 22 automation templates on a fresh database and re-runs as a no-op", async () => {
    expect(await listWorkflows()).toHaveLength(0);
    expect(await getScheduledTasks()).toHaveLength(0);

    // Boot order: scripts seed before schedules, so a script-target schedule
    // (daily-swarm-update-check) resolves its catalog script on a fresh install.
    const order = SEEDERS.map((seeder) => seeder.kind);
    expect(order.indexOf("script")).toBeLessThan(order.indexOf("schedule"));
    expect(await getScript({ name: "swarm-update-check", scope: "global" })).toBeNull();
    const scriptResult = await runSeeder(scriptsSeeder, {
      quiet: true,
      scriptEmbeddingMode: "skip",
    });
    const workflowResult = await runSeeder(workflowsSeeder, { quiet: true });
    const scheduleResult = await runSeeder(schedulesSeeder, { quiet: true });

    expect(scriptResult.failed).toEqual([]);
    expect(workflowResult).toMatchObject({ created: 11, failed: [] });
    expect(scheduleResult).toMatchObject({ created: 11, failed: [] });
    expect(await getScheduledTaskByName("daily-swarm-update-check")).toMatchObject({
      targetType: "script",
      scriptName: "swarm-update-check",
    });
    expect((await listWorkflows()).map((workflow) => workflow.name).sort()).toEqual(
      workflowsSeeder.items().map((item) => item.key),
    );
    expect((await getScheduledTasks()).map((schedule) => schedule.name).sort()).toEqual(
      (await schedulesSeeder.items()).map((item) => item.key),
    );

    expect(await runSeeder(workflowsSeeder, { quiet: true })).toMatchObject({
      created: 0,
      updated: 0,
      skippedUnchanged: 11,
      failed: [],
    });
    expect(await runSeeder(schedulesSeeder, { quiet: true })).toMatchObject({
      created: 0,
      updated: 0,
      skippedUnchanged: 11,
      failed: [],
    });
    expect(await listWorkflows()).toHaveLength(11);
    expect(await getScheduledTasks()).toHaveLength(11);
  }, 60_000); // typechecks every catalog script with tsc

  test("each SEED_*_ENABLED flag defaults to on and reproduces the full registry when unset", () => {
    expect(buildSeeders().map((seeder) => seeder.kind)).toEqual([
      "agent-fs-provision",
      "script",
      "skill",
      "workflow",
      "schedule",
    ]);
  });

  test.each([
    ["SEED_SCRIPTS_ENABLED", "script"],
    ["SEED_SKILLS_ENABLED", "skill"],
    ["SEED_WORKFLOWS_ENABLED", "workflow"],
    ["SEED_SCHEDULES_ENABLED", "schedule"],
  ] as const)("%s=false drops only the %s seeder, keeping agent-fs-provision", (envKey, kind) => {
    process.env[envKey] = "false";
    const kinds = buildSeeders().map((seeder) => seeder.kind);
    expect(kinds).not.toContain(kind);
    expect(kinds).toContain("agent-fs-provision");
    expect(kinds).toHaveLength(SEEDERS.length - 1);
  });

  test("all four flags off leaves only agent-fs-provision", () => {
    for (const key of SEED_TOGGLE_KEYS) process.env[key] = "false";
    expect(buildSeeders().map((seeder) => seeder.kind)).toEqual(["agent-fs-provision"]);
  });

  test.each([undefined, "true"])(
    "the seed CLI honors dashboard opt-outs over deployment flags (%s)",
    async (deploymentValue) => {
      for (const key of SEED_TOGGLE_KEYS) {
        await upsertSwarmConfig({ scope: "global", key, value: "false" });
      }
      // The preload serves test DBs from an in-memory template; the real CLI
      // needs the same saved configuration in a file-backed database.
      await Bun.write(TEST_DB_PATH, getDb().serialize());
      closeDb();
      const result = await runChild(
        [process.execPath, "--no-env-file", "scripts/seed-scripts.ts"],
        {
          env: {
            PATH: process.env.PATH,
            NODE_ENV: "test",
            DESPLEGA_TELEMETRY_ENV: "test",
            SECRETS_ENCRYPTION_KEY: process.env.SECRETS_ENCRYPTION_KEY,
            DATABASE_PATH: resolve(TEST_DB_PATH),
            ...Object.fromEntries(SEED_TOGGLE_KEYS.map((key) => [key, deploymentValue])),
          },
        },
      );
      const seededKinds = result.stdout.match(/^\[seed:[^\]]+\]/gm) ?? [];
      expect(seededKinds).toEqual(["[seed:agent-fs-provision]"]);
      expectChildOk(result, "seed CLI with dashboard opt-outs");
      const persisted = new Database(TEST_DB_PATH, { readonly: true });
      try {
        for (const table of ["scripts", "skills", "workflows", "scheduled_tasks"]) {
          expect(persisted.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({
            count: 0,
          });
        }
      } finally {
        persisted.close();
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );

  test.each([
    { disabledKeys: ["SEED_SCRIPTS_ENABLED"] },
    { disabledKeys: ["SEED_WORKFLOWS_ENABLED"] },
    { disabledKeys: ["SEED_SCRIPTS_ENABLED", "SEED_WORKFLOWS_ENABLED"] },
  ])("defers only missing opted-out schedule targets: %j", async ({ disabledKeys }) => {
    const scriptsOff = disabledKeys.includes("SEED_SCRIPTS_ENABLED");
    const workflowsOff = disabledKeys.includes("SEED_WORKFLOWS_ENABLED");
    for (const key of disabledKeys) process.env[key] = "false";
    if (!scriptsOff) await seedUpdateCheckTarget();
    if (!workflowsOff) await createWorkflow({ name: "dreaming", definition: { nodes: [] } });

    const seeder = buildSeeders().find((candidate) => candidate.kind === "schedule")!;
    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({
      created: 11 - disabledKeys.length,
      failed: [],
    });
    expect(await getScheduledTaskByName("daily-status-report")).not.toBeNull();
    if (scriptsOff) expect(await getScheduledTaskByName("daily-swarm-update-check")).toBeNull();
    if (workflowsOff) expect(await getScheduledTaskByName("dreaming-daily")).toBeNull();

    // Targets may be supplied externally later. Reuse the same seeder to prove
    // availability is checked at execution, not when the registry is built.
    if (scriptsOff) await seedUpdateCheckTarget();
    if (workflowsOff) await createWorkflow({ name: "dreaming", definition: { nodes: [] } });
    expect(await runSeeder(seeder, { quiet: true })).toMatchObject({
      created: disabledKeys.length,
      failed: [],
    });
    expect(await getScheduledTasks()).toHaveLength(11);
  });
});
