import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type AutomationSetupStates, preflightAutomation } from "../be/automation-preflight";
import { runMigrations } from "../be/migrations/runner";
import type { AutomationIntegrationId } from "../types";

const original = await Bun.file(
  new URL("../be/migrations/141_scheduled_task_automation_preflight.sql", import.meta.url),
).text();
const repair = await Bun.file(
  new URL("../be/migrations/151_repair_scheduled_task_required_params.sql", import.meta.url),
).text();

const canonicalNames = [
  "daily-blocker-digest",
  "daily-compounding-reflection",
  "daily-status-report",
  "daily-workflow-health-audit",
  "weekly-harness-upgrade-check",
  "weekly-dependabot-triage",
  "weekly-code-health-reports",
  "weekly-dora-metrics",
  "daily-hn-briefing",
  "gtm-weekly-review",
  "dream-daily",
];

interface ScheduleRow {
  name: string;
  taskTemplate: string | null;
  timezone: string;
  enabled: number;
  params: string;
  requiredParams: string;
  requires: string;
}

const setup: AutomationSetupStates = {
  slack: "verified",
  github: "verified",
  linear: "verified",
  jira: "verified",
  gsc: "verified",
  agentmail: "verified",
  agentfs: "verified",
};

function preflight(row: ScheduleRow) {
  return preflightAutomation(
    {
      id: row.name,
      name: row.name,
      kind: "schedule",
      params: JSON.parse(row.params),
      requiredParams: JSON.parse(row.requiredParams),
      requires: JSON.parse(row.requires) as AutomationIntegrationId[],
    },
    setup,
  );
}

describe("scheduled task required params repair", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    // Only the pre-141 columns consumed by the two data migrations.
    db.exec(`CREATE TABLE scheduled_tasks (
      name TEXT PRIMARY KEY, taskTemplate TEXT, timezone TEXT NOT NULL DEFAULT 'UTC',
      enabled INTEGER NOT NULL DEFAULT 1
    )`);
  });

  afterEach(() => db.close());

  function insert(name: string, taskTemplate: string | null) {
    db.run("INSERT INTO scheduled_tasks (name, taskTemplate) VALUES (?, ?)", [name, taskTemplate]);
  }

  function rows() {
    return db.query<ScheduleRow, []>("SELECT * FROM scheduled_tasks ORDER BY name").all();
  }

  test("repairs concretized legacy schedules after 141 and is idempotent", () => {
    for (const name of canonicalNames) {
      insert(name, "Run the configured report for example/project and send it to ops@example.org.");
    }
    db.exec(original);
    const before = rows();
    expect(before.filter((row) => preflight(row).state === "needs_setup")).toHaveLength(6);
    expect(before.find((row) => row.name === "weekly-dependabot-triage")?.timezone).toBe(
      "{{TIMEZONE}}",
    );

    db.exec(repair);
    expect(rows()).toEqual(
      before.map((row) => ({ ...row, requiredParams: "[]", timezone: "UTC" })),
    );
    for (const row of rows()) expect(preflight(row).state).toBe("running");

    const repaired = rows();
    db.exec(repair);
    expect(rows()).toEqual(repaired);
  });

  test("keeps every requirement on genuinely tokenized fresh templates", async () => {
    for (const name of canonicalNames.filter((name) => name !== "dream-daily")) {
      const template = new URL(`../../templates/schedules/${name}/content.md`, import.meta.url);
      insert(name, await Bun.file(template).text());
    }
    db.exec(original);
    const before = rows();

    db.exec(repair);
    expect(rows()).toEqual(before.map((row) => ({ ...row, timezone: "UTC" })));
    expect(rows().map((row) => preflight(row).missing)).toEqual(
      before.map((row) => preflight(row).missing),
    );
  });

  test("keeps referenced keys in order and checks exact case-sensitive tokens", () => {
    insert(
      "weekly-code-health-reports",
      "Report {{PAGE_ID}} for {{REPO_URL}}; {{BRANCH_SUFFIX}}, {{scope_path}}, REPORT_NAME",
    );
    db.exec(original);
    db.exec(repair);
    expect(rows()[0]?.requiredParams).toBe('["REPO_URL","PAGE_ID"]');
  });

  test("keeps timezone-only requirements when TIMEZONE has a binding", () => {
    insert("weekly-dependabot-triage", null);
    db.exec(original);
    db.run("UPDATE scheduled_tasks SET params = ?", ['{"TIMEZONE":"Europe/Paris"}']);
    db.exec(repair);
    expect(rows()[0]).toMatchObject({
      taskTemplate: null,
      timezone: "{{TIMEZONE}}",
      requiredParams: '["TIMEZONE"]',
      params: '{"TIMEZONE":"Europe/Paris"}',
      requires: '["github","slack"]',
    });
    expect(preflight(rows()[0]!).state).toBe("running");
  });

  test("restores an unbound timezone and removes unused requirements with a null body", () => {
    insert("weekly-dependabot-triage", null);
    db.exec(original);
    db.run("UPDATE scheduled_tasks SET params = ?", ['{"TIMEZONE":null}']);
    db.exec(repair);
    expect(rows()[0]).toMatchObject({ timezone: "UTC", requiredParams: "[]" });
  });

  test("leaves manual repairs and schedules outside 141 unchanged", () => {
    insert("weekly-dependabot-triage", "Review {{REPO_URL}}.");
    insert("custom-schedule", null);
    db.exec(original);
    db.exec(`UPDATE scheduled_tasks SET
      timezone = 'America/New_York', requiredParams = '[ "REPO_URL" ]',
      params = '{"REPO_URL":"example/project"}', enabled = 0
      WHERE name = 'weekly-dependabot-triage'`);
    db.exec(`UPDATE scheduled_tasks SET
      timezone = '{{TIMEZONE}}', requiredParams = '["TIMEZONE","CUSTOM"]'
      WHERE name = 'custom-schedule'`);
    const before = rows();
    db.exec(repair);
    expect(rows()).toEqual(before);
  });
});

test("the migration runner applies the repair on a fresh database", () => {
  const db = new Database(":memory:");
  try {
    runMigrations(db);
    const applied = db.query("SELECT * FROM _migrations WHERE version = 151").get();
    expect(applied).toMatchObject({ name: "151_repair_scheduled_task_required_params" });
    runMigrations(db);
    expect(db.query("SELECT * FROM _migrations WHERE version = 151").get()).toEqual(applied);
  } finally {
    db.close();
  }
});
