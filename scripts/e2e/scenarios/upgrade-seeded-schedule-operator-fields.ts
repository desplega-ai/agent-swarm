import { Database } from "bun:sqlite";
import { type DbFixture, loadDbFixture } from "../db";
import { type ApiClient, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// On/off, cron and timezone of a seeded schedule belong to the operator (issue #3651).
// A change to them must not stop the seeder from shipping a fixed prompt. The base
// fixture holds schedules a base-commit release seeded, with seed_state hashes in the
// format of that release. Before the API boots, this scenario turns them into the
// states an upgrade meets, all seeded from an older prompt:
//   - toggled:  switched off, cron and timezone changed, legacy hash -> new prompt, operator values kept
//   - control:  untouched, legacy hash -> new prompt (proves the hash replica below)
//   - edited:   a user rewrote the prompt -> kept as written
//   - current:  switched on after a seed in the current hash format -> new prompt, still on
const TOGGLED = "daily-status-report";
const CONTROL = "daily-blocker-digest";
const EDITED = "daily-compounding-reflection";
const CURRENT = "weekly-dora-metrics";
const OPERATOR_CRON = "45 6 * * *";
const OPERATOR_TIMEZONE = "Europe/Madrid";

type Row = {
  name: string;
  description: string | null;
  cronExpression: string | null;
  timezone: string;
  enabled: number;
  taskTemplate: string | null;
  taskType: string | null;
  tags: string;
  params: string;
  requiredParams: string;
  requires: string;
  targetType: string;
};

// The seeder's canonical JSON and sha256 (src/be/seed/workflows-seeder.ts canonicalJson).
function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sortJson(nested)]),
  );
}
const hash = (value: unknown) =>
  new Bun.CryptoHasher("sha256").update(JSON.stringify(sortJson(value))).digest("hex");

/** The schedule as the seeder hashes it: the whole schedule (legacy) or without the operator fields. */
function seedView(row: Row, overrides: Partial<Record<string, unknown>> = {}) {
  return {
    name: row.name,
    description: row.description ?? "",
    cronExpression: row.cronExpression ?? "",
    timezone: row.timezone,
    enabled: row.enabled === 1,
    taskTemplate: row.taskTemplate ?? "",
    taskType: row.taskType ?? "",
    tags: JSON.parse(row.tags),
    params: JSON.parse(row.params),
    requiredParams: JSON.parse(row.requiredParams),
    requires: JSON.parse(row.requires),
    ...overrides,
  };
}

async function liveSchedule(api: ApiClient, name: string) {
  const response = await api(
    "GET",
    `/api/schedules?${new URLSearchParams({ name, fields: "full" })}`,
  );
  expectStatus(response, [200], `list schedule ${name}`);
  const row = asRecords(response.json, "schedules").find((s) => s.name === name);
  expect(row !== undefined, `schedule ${name} is missing`);
  return row as Record<string, unknown>;
}

async function upgradeFixture(
  nonce: string,
  template: { cronExpression: string; timezone: string },
): Promise<{ fixture: DbFixture; toggledOn: boolean; currentOn: boolean }> {
  const fixture = await loadDbFixture("base-db");
  const db = Database.deserialize(fixture.file);
  try {
    const read = (name: string) => {
      const row = db.query("SELECT * FROM scheduled_tasks WHERE name = ?").get(name) as Row | null;
      expect(row?.targetType === "agent-task", `base fixture: ${name} is not a seeded prompt`);
      return row as Row;
    };
    const setRow = (name: string, fields: Record<string, string | number>) => {
      const keys = Object.keys(fields);
      db.run(
        `UPDATE scheduled_tasks SET ${keys.map((key) => `${key} = ?`).join(", ")} WHERE name = ?`,
        [...Object.values(fields), name],
      );
    };
    const setSeededHash = (name: string, seededHash: string) => {
      const changed = db.run(
        "UPDATE seed_state SET seededHash = ? WHERE kind = 'schedule' AND key = ?",
        [seededHash, name],
      );
      expect(changed.changes === 1, `base fixture: no seed_state row for ${name}`);
    };

    const toggled = read(TOGGLED);
    const toggledOn = toggled.enabled !== 1;
    const oldToggled = `Older ${TOGGLED} prompt ${nonce}`;
    setSeededHash(TOGGLED, hash(seedView(toggled, { taskTemplate: oldToggled, ...template })));
    setRow(TOGGLED, {
      taskTemplate: oldToggled,
      enabled: toggledOn ? 1 : 0,
      cronExpression: OPERATOR_CRON,
      timezone: OPERATOR_TIMEZONE,
    });

    const control = read(CONTROL);
    const oldControl = `Older ${CONTROL} prompt ${nonce}`;
    setSeededHash(CONTROL, hash(seedView(control, { taskTemplate: oldControl })));
    setRow(CONTROL, { taskTemplate: oldControl });

    read(EDITED);
    setRow(EDITED, { taskTemplate: `Operator prompt ${nonce}` });

    const current = read(CURRENT);
    const currentOn = current.enabled !== 1;
    const oldCurrent = `Older ${CURRENT} prompt ${nonce}`;
    const {
      enabled: _e,
      cronExpression: _c,
      timezone: _t,
      ...currentView
    } = seedView(current, {
      taskTemplate: oldCurrent,
    });
    setSeededHash(CURRENT, hash(currentView));
    setRow(CURRENT, { taskTemplate: oldCurrent, enabled: currentOn ? 1 : 0 });

    return {
      fixture: { ...fixture, name: "seeded-schedule-operator-fields", file: db.serialize() },
      toggledOn,
      currentOn,
    };
  } finally {
    db.close();
  }
}

export const upgradeSeededScheduleOperatorFields: Scenario = {
  name: "upgrade-seeded-schedule-operator-fields",
  order: 9_155,
  async run(ctx) {
    // The main API seeded the current templates on this engine: the expected prompts.
    const expected = new Map<string, Record<string, unknown>>();
    for (const name of [TOGGLED, CONTROL, EDITED, CURRENT]) {
      expected.set(name, await liveSchedule(ctx.api, name));
    }
    const toggledTemplate = expected.get(TOGGLED)!;
    const upgrade = await upgradeFixture(ctx.nonce, {
      cronExpression: String(toggledTemplate.cronExpression),
      timezone: String(toggledTemplate.timezone),
    });
    const fixture = await ctx.startFixtureSut(upgrade.fixture);
    try {
      const toggled = await liveSchedule(fixture.api, TOGGLED);
      expect(
        toggled.taskTemplate === toggledTemplate.taskTemplate,
        `${TOGGLED}: an operator toggle kept the older prompt: ${String(toggled.taskTemplate).slice(0, 120)}`,
      );
      expect(
        toggled.enabled === upgrade.toggledOn,
        `${TOGGLED}: the operator's on/off was reset to ${String(toggled.enabled)}`,
      );
      expect(
        toggled.cronExpression === OPERATOR_CRON && toggled.timezone === OPERATOR_TIMEZONE,
        `${TOGGLED}: the operator's cron and timezone were reset to ${String(toggled.cronExpression)} ${String(toggled.timezone)}`,
      );
      expect(
        toggled.enabled ? Boolean(toggled.nextRunAt) : !toggled.nextRunAt,
        `${TOGGLED}: nextRunAt ${String(toggled.nextRunAt)} does not follow the kept on/off`,
      );

      const control = await liveSchedule(fixture.api, CONTROL);
      expect(
        control.taskTemplate === expected.get(CONTROL)?.taskTemplate,
        `${CONTROL}: an untouched legacy row kept the older prompt (hash replica broken?)`,
      );

      const edited = await liveSchedule(fixture.api, EDITED);
      expect(
        edited.taskTemplate === `Operator prompt ${ctx.nonce}`,
        `${EDITED}: the seeder overwrote a prompt a user wrote: ${String(edited.taskTemplate).slice(0, 120)}`,
      );

      const current = await liveSchedule(fixture.api, CURRENT);
      expect(
        current.taskTemplate === expected.get(CURRENT)?.taskTemplate,
        `${CURRENT}: a toggle after a current-format seed kept the older prompt`,
      );
      expect(
        current.enabled === upgrade.currentOn,
        `${CURRENT}: the operator's on/off was reset to ${String(current.enabled)}`,
      );
    } finally {
      await fixture.stop();
    }
  },
};
