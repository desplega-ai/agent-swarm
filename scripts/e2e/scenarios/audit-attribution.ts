// Audit attribution on scripts, skills, workflows and schedules: every user-intent write
// records the writing agent (`createdByAgentId` / `updatedByAgentId`) and the person behind it
// (`created_by` / `updated_by`, the requester of the caller's own source task). Each scenario
// walks one model through its HTTP routes and MCP tools: a create, an update by a different
// agent and person (the creating pair stays), and an update with no person attached (the
// updating person is NULL, never left over from the previous writer).
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  createAssignedTask,
  createUser,
  expectToolOk,
  registerWorker,
  retireAgent,
} from "./core-helpers";
import { getLead } from "./script-helpers";

/** An agent working a task that a person requested: the identity a write is attributed to. */
type Actor = { agentId: string; userId: string; taskId: string };

type AuditRow = {
  createdByAgentId: string | null;
  updatedByAgentId: string | null;
  created_by: string | null;
  updated_by: string | null;
};

type Expected = {
  createdAgent: string | null;
  createdPerson: string | null;
  updatedAgent: string | null;
  updatedPerson: string | null;
};

async function actor(ctx: ScenarioContext, agentId: string, label: string): Promise<Actor> {
  const userId = await createUser(ctx, `audit-${label}`);
  // Assigned and left pending: the audit resolver accepts a source task the caller owns, and a
  // pending task never becomes the agent's "current task" fallback.
  const taskId = await createAssignedTask(ctx, agentId, `audit ${label} ${ctx.nonce}`, {
    requestedByUserId: userId,
  });
  return { agentId, userId, taskId };
}

const onTask = (who: Actor) => ({ "X-Source-Task-Id": who.taskId });

async function mcpAs<T>(
  ctx: ScenarioContext,
  agentId: string,
  headers: Record<string, string>,
  fn: (connection: McpConnection) => Promise<T>,
): Promise<T> {
  const connection = await ctx.connectMcp(agentId, { headers });
  try {
    return await fn(connection);
  } finally {
    await connection.close();
  }
}

const TABLES = {
  scripts: "scripts",
  skills: "skills",
  workflows: "workflows",
  schedules: "scheduled_tasks",
} as const;

function expectAudit(
  ctx: ScenarioContext,
  model: keyof typeof TABLES,
  id: string,
  want: Expected,
  step: string,
): void {
  const row = ctx.db.get<AuditRow>(
    `SELECT createdByAgentId, updatedByAgentId, created_by, updated_by FROM ${TABLES[model]} WHERE id = ?`,
    [id],
  );
  expect(row, `${model} ${id} has no row (${step})`);
  const got: Expected = {
    createdAgent: row.createdByAgentId,
    createdPerson: row.created_by,
    updatedAgent: row.updatedByAgentId,
    updatedPerson: row.updated_by,
  };
  expect(
    JSON.stringify(got) === JSON.stringify(want),
    `${model} audit after ${step}: want ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
  );
}

/** The audit pair a create records: the creator on both sides. */
const created = (who: Actor): Expected => ({
  createdAgent: who.agentId,
  createdPerson: who.userId,
  updatedAgent: who.agentId,
  updatedPerson: who.userId,
});

const updated = (base: Expected, agentId: string, userId: string | null): Expected => ({
  ...base,
  updatedAgent: agentId,
  updatedPerson: userId,
});

function skillMarkdown(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

const bashNode = (id: string, text: string) => ({
  id,
  type: "script",
  config: { runtime: "bash", script: `echo ${text}` },
});

const YEARLY = "0 3 1 1 *";

export const auditAttributionWorkflows: Scenario = {
  name: "audit-attribution-workflows",
  order: 345,
  async run(ctx) {
    const a = await actor(ctx, await registerWorker(ctx, "audit-wf-a"), "wf-a");
    const b = await actor(ctx, await registerWorker(ctx, "audit-wf-b"), "wf-b");
    const workflowIds: string[] = [];
    try {
      // ── HTTP create by A, MCP update by B, HTTP update with no person ───────────────────
      const posted = await ctx.api("POST", "/api/workflows", {
        agentId: a.agentId,
        headers: onTask(a),
        body: {
          name: `audit-wf-http-${ctx.nonce}`,
          definition: { nodes: [bashNode("one", "one")] },
        },
      });
      expectStatus(posted, [201], "create a workflow over HTTP");
      const httpWorkflow = asRecord(posted.json);
      const httpId = asString(httpWorkflow.id, "workflow id");
      workflowIds.push(httpId);
      expect(
        httpWorkflow.createdByAgentId === a.agentId &&
          httpWorkflow.updatedByAgentId === a.agentId &&
          httpWorkflow.createdBy === a.userId &&
          httpWorkflow.updatedBy === a.userId,
        `POST /api/workflows response lacks the audit pair: ${posted.text.slice(0, 400)}`,
      );
      const httpCreated = created(a);
      expectAudit(ctx, "workflows", httpId, httpCreated, "HTTP create");

      const mcpUpdated = await mcpAs(ctx, b.agentId, onTask(b), (connection) =>
        expectToolOk(connection, "update-workflow", {
          id: httpId,
          description: `updated by B ${ctx.nonce}`,
        }),
      );
      expect(
        asRecord(mcpUpdated.data.workflow).updatedByAgentId === b.agentId,
        "update-workflow result does not carry the updating agent",
      );
      expectAudit(
        ctx,
        "workflows",
        httpId,
        updated(httpCreated, b.agentId, b.userId),
        "MCP update-workflow by B",
      );

      const put = await ctx.api("PUT", `/api/workflows/${httpId}`, {
        agentId: a.agentId,
        body: { description: `updated with no person ${ctx.nonce}` },
      });
      expectStatus(put, [200], "update a workflow over HTTP with no source task");
      expectAudit(
        ctx,
        "workflows",
        httpId,
        updated(httpCreated, a.agentId, null),
        "HTTP PUT with no source task",
      );

      // Naming a task the caller does not own records no person.
      const spoofed = await ctx.api("PATCH", `/api/workflows/${httpId}`, {
        agentId: b.agentId,
        headers: onTask(a),
        body: { update: [{ nodeId: "one", node: { label: "spoofed" } }] },
      });
      expectStatus(spoofed, [200], "patch a workflow naming another agent's task");
      expectAudit(
        ctx,
        "workflows",
        httpId,
        updated(httpCreated, b.agentId, null),
        "HTTP PATCH naming another agent's task",
      );

      // ── MCP create by A, HTTP PATCH by B, MCP patch with no person ─────────────────────
      const mcpCreated = await mcpAs(ctx, a.agentId, onTask(a), (connection) =>
        expectToolOk(connection, "create-workflow", {
          name: `audit-wf-mcp-${ctx.nonce}`,
          definition: { nodes: [bashNode("one", "one")] },
        }),
      );
      const mcpId = asString(asRecord(mcpCreated.data.workflow).id, "MCP workflow id");
      workflowIds.push(mcpId);
      const mcpCreatedPair = created(a);
      expectAudit(ctx, "workflows", mcpId, mcpCreatedPair, "MCP create-workflow");

      const patched = await ctx.api("PATCH", `/api/workflows/${mcpId}`, {
        agentId: b.agentId,
        headers: onTask(b),
        body: { update: [{ nodeId: "one", node: { label: "patched by B" } }] },
      });
      expectStatus(patched, [200], "patch a workflow over HTTP");
      expectAudit(
        ctx,
        "workflows",
        mcpId,
        updated(mcpCreatedPair, b.agentId, b.userId),
        "HTTP PATCH by B",
      );

      await mcpAs(ctx, a.agentId, {}, (connection) =>
        expectToolOk(connection, "patch-workflow", {
          id: mcpId,
          update: [{ nodeId: "one", node: { label: "patched with no person" } }],
        }),
      );
      expectAudit(
        ctx,
        "workflows",
        mcpId,
        updated(mcpCreatedPair, a.agentId, null),
        "MCP patch-workflow with no source task",
      );

      const read = await ctx.api("GET", `/api/workflows/${mcpId}`);
      expectStatus(read, [200], "read the workflow");
      const readWorkflow = asRecord(read.json);
      expect(
        readWorkflow.createdByAgentId === a.agentId &&
          readWorkflow.createdBy === a.userId &&
          readWorkflow.updatedByAgentId === a.agentId &&
          readWorkflow.updatedBy === undefined,
        `GET /api/workflows/:id audit fields: ${read.text.slice(0, 400)}`,
      );
    } finally {
      for (const id of workflowIds) await ctx.api("DELETE", `/api/workflows/${id}`);
      await cancelQuietly(ctx, a.taskId);
      await cancelQuietly(ctx, b.taskId);
    }
  },
};

export const auditAttributionSchedules: Scenario = {
  name: "audit-attribution-schedules",
  order: 356,
  async run(ctx) {
    const a = await actor(ctx, await registerWorker(ctx, "audit-sched-a"), "sched-a");
    const b = await actor(ctx, await registerWorker(ctx, "audit-sched-b"), "sched-b");
    const scheduleIds: string[] = [];
    try {
      // ── HTTP create by A, MCP update by B, HTTP PATCH with no person ───────────────────
      const posted = await ctx.api("POST", "/api/schedules", {
        agentId: a.agentId,
        headers: onTask(a),
        body: {
          name: `audit-sched-http-${ctx.nonce}`,
          cronExpression: YEARLY,
          taskTemplate: `audit schedule ${ctx.nonce}`,
          targetAgentId: a.agentId,
        },
      });
      expectStatus(posted, [201], "create a schedule over HTTP");
      const httpSchedule = asRecord(posted.json);
      const httpId = asString(httpSchedule.id, "schedule id");
      scheduleIds.push(httpId);
      expect(
        httpSchedule.createdByAgentId === a.agentId,
        `POST /api/schedules did not record the creating agent: ${posted.text.slice(0, 400)}`,
      );
      const httpCreated = created(a);
      expectAudit(ctx, "schedules", httpId, httpCreated, "HTTP create");

      const mcpUpdated = await mcpAs(ctx, b.agentId, onTask(b), (connection) =>
        expectToolOk(connection, "update-schedule", {
          scheduleId: httpId,
          description: `updated by B ${ctx.nonce}`,
        }),
      );
      expect(
        asRecord(mcpUpdated.data.schedule).updatedByAgentId === b.agentId,
        "update-schedule result does not carry the updating agent",
      );
      expectAudit(
        ctx,
        "schedules",
        httpId,
        updated(httpCreated, b.agentId, b.userId),
        "MCP update-schedule by B",
      );

      const patched = await ctx.api("PATCH", `/api/schedules/${httpId}`, {
        agentId: a.agentId,
        body: { description: `updated with no person ${ctx.nonce}` },
      });
      expectStatus(patched, [200], "patch a schedule over HTTP with no source task");
      expectAudit(
        ctx,
        "schedules",
        httpId,
        updated(httpCreated, a.agentId, null),
        "HTTP PATCH with no source task",
      );

      // ── MCP create by A, HTTP PUT by B, MCP patch with no person ───────────────────────
      const mcpCreated = await mcpAs(ctx, a.agentId, onTask(a), (connection) =>
        expectToolOk(connection, "create-schedule", {
          name: `audit-sched-mcp-${ctx.nonce}`,
          cronExpression: YEARLY,
          taskTemplate: `audit schedule mcp ${ctx.nonce}`,
          targetAgentId: a.agentId,
        }),
      );
      const mcpId = asString(asRecord(mcpCreated.data.schedule).id, "MCP schedule id");
      scheduleIds.push(mcpId);
      const mcpCreatedPair = created(a);
      expectAudit(ctx, "schedules", mcpId, mcpCreatedPair, "MCP create-schedule");

      const put = await ctx.api("PUT", `/api/schedules/${mcpId}`, {
        agentId: b.agentId,
        headers: onTask(b),
        body: { description: `put by B ${ctx.nonce}` },
      });
      expectStatus(put, [200], "update a schedule over HTTP");
      expectAudit(
        ctx,
        "schedules",
        mcpId,
        updated(mcpCreatedPair, b.agentId, b.userId),
        "HTTP PUT by B",
      );

      await mcpAs(ctx, a.agentId, {}, (connection) =>
        expectToolOk(connection, "patch-schedule", {
          scheduleId: mcpId,
          description: `patched with no person ${ctx.nonce}`,
        }),
      );
      expectAudit(
        ctx,
        "schedules",
        mcpId,
        updated(mcpCreatedPair, a.agentId, null),
        "MCP patch-schedule with no source task",
      );
    } finally {
      for (const id of scheduleIds) await ctx.api("DELETE", `/api/schedules/${id}`);
      await cancelQuietly(ctx, a.taskId);
      await cancelQuietly(ctx, b.taskId);
    }
  },
};

export const auditAttributionScripts: Scenario = {
  name: "audit-attribution-scripts",
  order: 495,
  async run(ctx) {
    // Global scope is the only one two agents can both write, and it takes a lead.
    const lead = await actor(ctx, await getLead(ctx), "script-lead");
    const secondLeadResponse = await ctx.api("POST", "/api/agents", {
      // Sorts after every other lead, so it never becomes the routing lead; retired below.
      body: { name: `zz-audit-lead-${ctx.nonce}`, isLead: true },
    });
    expectStatus(secondLeadResponse, [201], "register a second lead");
    const lead2 = await actor(
      ctx,
      asString(asRecord(secondLeadResponse.json).id, "second lead id"),
      "script-lead-2",
    );
    const worker = await actor(ctx, await registerWorker(ctx, "audit-script-w"), "script-w");
    const name = `audit-script-${ctx.nonce}`;
    const source = (n: number) =>
      `export default async function (args: unknown) { return { n: ${n} }; }\n`;
    let skillId: string | undefined;
    try {
      // ── HTTP create by lead, MCP update by the second lead, HTTP update with no person ──
      const posted = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: lead.agentId,
        headers: onTask(lead),
        body: { name, scope: "global", source: source(1), description: "audit" },
      });
      expectStatus(posted, [200], "create a global script over HTTP");
      const row = ctx.db.get<{ id: string }>(
        "SELECT id FROM scripts WHERE name = ? AND scope = 'global'",
        [name],
      );
      expect(row, "global script row missing");
      const createdPair = created(lead);
      expectAudit(ctx, "scripts", row.id, createdPair, "HTTP upsert create");

      await mcpAs(ctx, lead2.agentId, onTask(lead2), (connection) =>
        expectToolOk(connection, "script-upsert", { name, scope: "global", source: source(2) }),
      );
      expectAudit(
        ctx,
        "scripts",
        row.id,
        updated(createdPair, lead2.agentId, lead2.userId),
        "MCP script-upsert by the second lead",
      );

      const noPerson = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: lead.agentId,
        body: { name, scope: "global", source: source(3) },
      });
      expectStatus(noPerson, [200], "update a global script over HTTP with no source task");
      expectAudit(
        ctx,
        "scripts",
        row.id,
        updated(createdPair, lead.agentId, null),
        "HTTP upsert with no source task",
      );

      const listed = await ctx.api("GET", "/api/scripts?scope=global");
      expectStatus(listed, [200], "list global scripts");
      const item = asRecords(listed.json, "scripts").find((script) => script.id === row.id);
      expect(
        item &&
          item.createdByAgentId === lead.agentId &&
          item.createdBy === lead.userId &&
          item.updatedByAgentId === lead.agentId &&
          item.updatedBy === null,
        `GET /api/scripts audit fields: ${JSON.stringify(item).slice(0, 400)}`,
      );

      // ── an inline run on a task: the scratch auto-save and its ctx.swarm writes ─────────
      const skillName = `audit-sdk-skill-${ctx.nonce}`;
      const run = await ctx.api("POST", "/api/scripts/run", {
        agentId: worker.agentId,
        headers: onTask(worker),
        body: {
          source: `export default async function (args: { content: string }, ctx: any) {
  return await ctx.swarm.skill_create({ content: args.content });
}`,
          args: { content: skillMarkdown(skillName, "created inside a script run", "Body.") },
        },
      });
      expectStatus(run, [200], "inline run on a requested task");
      const envelope = asRecord(run.json);
      expect(
        envelope.exitCode === 0 && envelope.error === undefined,
        `inline run failed: ${run.text.slice(0, 500)}`,
      );
      const slug = asString(asRecord(envelope.autoSaved).slug, "scratch slug");
      const scratch = ctx.db.get<{ id: string }>(
        "SELECT id FROM scripts WHERE name = ? AND scopeId = ?",
        [slug, worker.agentId],
      );
      expect(scratch, "scratch script row missing");
      expectAudit(ctx, "scripts", scratch.id, created(worker), "inline run scratch auto-save");

      const skill = ctx.db.get<{ id: string }>("SELECT id FROM skills WHERE name = ?", [skillName]);
      expect(skill, "ctx.swarm.skill_create wrote no skill");
      skillId = skill.id;
      expectAudit(ctx, "skills", skill.id, created(worker), "ctx.swarm.skill_create in a run");
    } finally {
      if (skillId) await ctx.api("DELETE", `/api/skills/${skillId}`);
      await ctx.api("DELETE", `/api/scripts/${name}?scope=global`, { agentId: lead.agentId });
      for (const who of [lead, lead2, worker]) await cancelQuietly(ctx, who.taskId);
      await retireAgent(ctx, lead2.agentId);
    }
  },
};

export const auditAttributionSkills: Scenario = {
  name: "audit-attribution-skills",
  order: 585,
  async run(ctx) {
    const a = await actor(ctx, await registerWorker(ctx, "audit-skill-a"), "skill-a");
    const b = await actor(ctx, await registerWorker(ctx, "audit-skill-b"), "skill-b");
    const skillIds: string[] = [];
    try {
      // ── MCP create by A, HTTP update by B, MCP update with no person ───────────────────
      const mcpName = `audit-skill-mcp-${ctx.nonce}`;
      const mcpCreated = await mcpAs(ctx, a.agentId, onTask(a), (connection) =>
        expectToolOk(connection, "skill-create", {
          content: skillMarkdown(mcpName, "created over MCP", "Body."),
        }),
      );
      const mcpId = asString(asRecord(mcpCreated.data.skill).id, "MCP skill id");
      skillIds.push(mcpId);
      const mcpPair = created(a);
      expectAudit(ctx, "skills", mcpId, mcpPair, "MCP skill-create");

      const put = await ctx.api("PUT", `/api/skills/${mcpId}`, {
        agentId: b.agentId,
        headers: onTask(b),
        body: { content: skillMarkdown(mcpName, "updated by B over HTTP", "Body two.") },
      });
      expectStatus(put, [200], "update a skill over HTTP");
      const putSkill = asRecord(asRecord(put.json).skill);
      expect(
        putSkill.createdByAgentId === a.agentId &&
          putSkill.createdBy === a.userId &&
          putSkill.updatedByAgentId === b.agentId &&
          putSkill.updatedBy === b.userId,
        `PUT /api/skills/:id audit fields: ${put.text.slice(0, 400)}`,
      );
      expectAudit(ctx, "skills", mcpId, updated(mcpPair, b.agentId, b.userId), "HTTP PUT by B");

      await mcpAs(ctx, a.agentId, {}, (connection) =>
        expectToolOk(connection, "skill-update", {
          skillId: mcpId,
          content: skillMarkdown(mcpName, "updated with no person", "Body three."),
        }),
      );
      expectAudit(
        ctx,
        "skills",
        mcpId,
        updated(mcpPair, a.agentId, null),
        "MCP skill-update with no source task",
      );

      // ── HTTP create by A, MCP update for a second person, file upsert by B ──────────────
      const httpName = `audit-skill-http-${ctx.nonce}`;
      const posted = await ctx.api("POST", "/api/skills", {
        agentId: a.agentId,
        headers: onTask(a),
        body: {
          content: skillMarkdown(httpName, "created over HTTP", "Body."),
          scope: "agent",
          ownerAgentId: a.agentId,
        },
      });
      expectStatus(posted, [201], "create a skill over HTTP");
      const httpId = asString(asRecord(asRecord(posted.json).skill).id, "HTTP skill id");
      skillIds.push(httpId);
      const httpPair = created(a);
      expectAudit(ctx, "skills", httpId, httpPair, "HTTP create");

      // skill-update is owner-or-lead, so the second writer is the owner on another task.
      const a2 = await actor(ctx, a.agentId, "skill-a2");
      try {
        await mcpAs(ctx, a2.agentId, onTask(a2), (connection) =>
          expectToolOk(connection, "skill-update", {
            skillId: httpId,
            content: skillMarkdown(httpName, "updated over MCP", "Body two."),
          }),
        );
        expectAudit(
          ctx,
          "skills",
          httpId,
          updated(httpPair, a.agentId, a2.userId),
          "MCP skill-update for a second person",
        );

        // A bundled-file write is an edit too.
        const file = await ctx.api("PUT", `/api/skills/${httpId}/files/notes.md`, {
          agentId: b.agentId,
          headers: onTask(b),
          body: { content: "notes" },
        });
        expectStatus(file, [200], "upsert a bundled skill file");
        expectAudit(
          ctx,
          "skills",
          httpId,
          updated(httpPair, b.agentId, b.userId),
          "HTTP bundled file upsert by B",
        );
      } finally {
        await cancelQuietly(ctx, a2.taskId);
      }
    } finally {
      for (const id of skillIds) await ctx.api("DELETE", `/api/skills/${id}`);
      await cancelQuietly(ctx, a.taskId);
      await cancelQuietly(ctx, b.taskId);
    }
  },
};
