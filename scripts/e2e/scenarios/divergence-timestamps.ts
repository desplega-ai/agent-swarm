// Locks the wire format of each timestamp class the API sends today, so another storage
// engine must render the same strings and numbers:
//   - ISO with milliseconds and Z, from a database default (task steering messages) and
//     from values the server writes itself (tasks, agents, session costs);
//   - "YYYY-MM-DD HH:MM:SS" sent raw (seeded RBAC roles and task templates);
//   - the same second-precision column sent normalized to ".000Z" (pages, metrics);
//   - epoch milliseconds as JSON integers (KV entries, pricing rows, budgets).
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cancelQuietly, createAssignedTask, registerWorker } from "./core-helpers";

const ISO_MS_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const ISO_SECOND_Z = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.000Z$/;
const SPACE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const TEN_MINUTES = 10 * 60_000;

function expectIso(value: unknown, pattern: RegExp, label: string, recent = true): string {
  const text = asString(value, label);
  expect(pattern.test(text), `${label} has format "${text}", expected ${pattern}`);
  if (recent) {
    const ms = Date.parse(text);
    expect(
      Math.abs(ms - Date.now()) < TEN_MINUTES,
      `${label} "${text}" is not within ten minutes of now`,
    );
  }
  return text;
}

function expectEpochMs(value: unknown, label: string, around = Date.now()): number {
  expect(
    typeof value === "number" && Number.isInteger(value),
    `${label} is ${JSON.stringify(value)} (${typeof value}), expected an integer of epoch ms`,
  );
  expect(
    Math.abs(value - around) < TEN_MINUTES,
    `${label} ${value} is not epoch ms within ten minutes of ${around}`,
  );
  return value;
}

async function isoClass(ctx: ScenarioContext, agentId: string): Promise<string> {
  const agent = await ctx.api("GET", `/api/agents/${agentId}`);
  expectStatus(agent, [200], "read agent");
  expectIso(asRecord(agent.json).createdAt, ISO_MS_Z, "agent createdAt");
  expectIso(asRecord(agent.json).lastUpdatedAt, ISO_MS_Z, "agent lastUpdatedAt");

  const taskId = await createAssignedTask(ctx, agentId, `div timestamps ${ctx.nonce}`);
  const task = await ctx.api("GET", `/api/tasks/${taskId}`);
  expectStatus(task, [200], "read task");
  expectIso(asRecord(task.json).createdAt, ISO_MS_Z, "task createdAt");
  expectIso(asRecord(task.json).lastUpdatedAt, ISO_MS_Z, "task lastUpdatedAt");

  // created_at comes from the column default, not from the server.
  const steer = await ctx.api("POST", `/api/tasks/${taskId}/steer`, {
    body: { message: `div timestamps steer ${ctx.nonce}` },
  });
  expectStatus(steer, [200], "steer the task");
  const messages = await ctx.api("GET", `/api/tasks/${taskId}/steering-messages`);
  expectStatus(messages, [200], "list steering messages");
  const rows = asRecords(messages.json, "messages");
  expect(rows.length === 1, `expected one steering message, got ${rows.length}`);
  expectIso(rows[0]?.createdAt, ISO_MS_Z, "steering message createdAt");

  const cost = await ctx.api("POST", "/api/session-costs", {
    body: {
      sessionId: `div-ts-${ctx.nonce}`,
      agentId,
      totalCostUsd: 0.5,
      inputTokens: 10,
      outputTokens: 20,
      model: `div-ts-model-${ctx.nonce}`,
    },
  });
  expectStatus(cost, [201], "store a session cost");
  expectIso(asRecord(asRecord(cost.json).cost).createdAt, ISO_MS_Z, "session cost createdAt");
  return taskId;
}

async function spaceClass(ctx: ScenarioContext, agentId: string): Promise<string> {
  // Rows seeded at boot by the schema itself: their createdAt comes back unconverted.
  const roles = await ctx.api("GET", "/api/rbac/roles");
  expectStatus(roles, [200], "list RBAC roles");
  const roleRows = asRecords(roles.json, "roles");
  const admin = roleRows.find((role) => role.name === "admin");
  expect(admin !== undefined, "no built-in admin role");
  for (const role of roleRows.filter((row) => row.isBuiltin === true)) {
    expectIso(role.createdAt, SPACE, `role ${String(role.name)} createdAt`, false);
  }
  const templates = await ctx.api("GET", "/api/task-templates");
  expectStatus(templates, [200], "list task templates");
  const templateRows = asRecords(templates.json, "templates");
  expect(templateRows.length > 0, "no seeded task templates");
  for (const template of templateRows) {
    expectIso(template.createdAt, SPACE, `task template ${String(template.id)} createdAt`, false);
  }

  // Pages store the same second-precision value and the API rewrites it to ".000Z".
  const created = await ctx.api("POST", "/api/pages", {
    agentId,
    body: {
      title: `div timestamps ${ctx.nonce}`,
      slug: `div-ts-${ctx.nonce}`,
      contentType: "text/html",
      body: "<p>t</p>",
    },
  });
  expectStatus(created, [201], "create page");
  const pageId = asString(asRecord(created.json).id, "page id");
  const page = await ctx.api("GET", `/api/pages/${pageId}`);
  expectStatus(page, [200], "read page");
  const createdAt = expectIso(asRecord(page.json).createdAt, ISO_SECOND_Z, "page createdAt");
  expectIso(asRecord(page.json).updatedAt, ISO_SECOND_Z, "page updatedAt");
  const listed = await ctx.api("GET", `/api/pages?q=div-ts-${ctx.nonce}`);
  expectStatus(listed, [200], "list pages");
  const listedPage = asRecords(listed.json, "pages").find((row) => row.id === pageId);
  expect(listedPage?.createdAt === createdAt, "the page list sends another createdAt");
  expectIso(listedPage?.updatedAt, ISO_SECOND_Z, "listed page updatedAt");

  const metrics = await ctx.api("GET", "/api/metrics/definitions?limit=500");
  expectStatus(metrics, [200], "list metric definitions");
  for (const metric of asRecords(metrics.json, "metrics").filter(
    (row) => row.agentId === "system",
  )) {
    expectIso(metric.createdAt, ISO_SECOND_Z, `metric ${String(metric.slug)} createdAt`, false);
  }
  return pageId;
}

async function epochClass(ctx: ScenarioContext, agentId: string): Promise<void> {
  const key = `div-ts-${ctx.nonce}`;
  const before = Date.now();
  const put = await ctx.api("PUT", `/api/kv/${key}`, {
    agentId,
    body: { value: { at: "now" }, expiresInSec: 3600 },
  });
  expectStatus(put, [200], "kv put");
  const entry = asRecord(put.json);
  const createdAt = expectEpochMs(entry.createdAt, "kv createdAt", before);
  expectEpochMs(entry.updatedAt, "kv updatedAt", before);
  expectEpochMs(entry.expiresAt, "kv expiresAt", before + 3_600_000);
  const get = await ctx.api("GET", `/api/kv/${key}`, { agentId });
  expectStatus(get, [200], "kv get");
  expect(asRecord(get.json).createdAt === createdAt, "kv get changed createdAt");
  const persistent = await ctx.api("PUT", `/api/kv/${key}-p`, { agentId, body: { value: 1 } });
  expectStatus(persistent, [200], "kv put without expiry");
  expect(asRecord(persistent.json).expiresAt === null, "kv without expiry sends expiresAt null");
  const list = await ctx.api("GET", `/api/kv?prefix=${key}`, { agentId });
  expectStatus(list, [200], "kv list");
  for (const row of asRecords(list.json, "entries")) {
    expectEpochMs(row.createdAt, "kv list createdAt", before);
  }
  for (const suffix of ["", "-p"]) {
    expectStatus(
      await ctx.api("DELETE", `/api/kv/${key}${suffix}`, { agentId }),
      [200, 204],
      "kv delete",
    );
  }

  const model = `div-ts-${ctx.nonce}`;
  const pricing = await ctx.api("POST", `/api/pricing/claude/${model}/input`, {
    body: { pricePerMillionUsd: 1.25, effectiveFrom: 1_000 },
  });
  expectStatus(pricing, [201], "insert pricing row");
  const row = asRecord(pricing.json);
  expect(row.effectiveFrom === 1_000, `pricing effectiveFrom ${String(row.effectiveFrom)}`);
  expectEpochMs(row.createdAt, "pricing createdAt");
  expectEpochMs(row.lastUpdatedAt, "pricing lastUpdatedAt");
  expectStatus(
    await ctx.api("DELETE", `/api/pricing/claude/${model}/input/1000`),
    [200, 204],
    "delete pricing row",
  );

  const budget = await ctx.api("PUT", `/api/budgets/agent/${agentId}`, {
    body: { dailyBudgetUsd: 100 },
  });
  expectStatus(budget, [200], "set budget");
  expectEpochMs(asRecord(budget.json).createdAt, "budget createdAt");
  expectStatus(await ctx.api("DELETE", `/api/budgets/agent/${agentId}`), [204], "delete budget");
}

export const divergenceTimestamps: Scenario = {
  name: "divergence-timestamps",
  order: 9_233,
  async run(ctx) {
    const agentId = await registerWorker(ctx, "div-ts");
    const taskId = await isoClass(ctx, agentId);
    const pageId = await spaceClass(ctx, agentId);
    await epochClass(ctx, agentId);
    expectStatus(await ctx.api("DELETE", `/api/pages/${pageId}`), [200, 204], "delete page");
    await cancelQuietly(ctx, taskId);
  },
};
