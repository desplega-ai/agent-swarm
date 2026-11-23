import { sql } from "../db";
// An agent-bound token (aseph_) acts only as its own agent on three routes that take an
// agent identity from the request: a script endpoint's run-as agent, a manual schedule run,
// and the owner of indexed memory. The lead's token keeps cross-agent access. The shared
// key, with or without an X-Agent-ID, behaves as before.
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { retireAgent } from "./core-helpers";
import { upsertScript } from "./script-helpers";
import { callToolErr, callToolOk } from "./workflow-helpers";

type Agent = { id: string; token: string };

// 03:00 on 1 January: never due while the suite runs.
const YEARLY = "0 3 1 1 *";
const RUN_DENIED = "Only that agent or a lead can run it";

async function registerWithToken(
  ctx: ScenarioContext,
  label: string,
  isLead = false,
): Promise<Agent> {
  // "zz-" keeps the lead out of first place in the by-name lead lookup.
  const name = `zz-ident-${label}-${ctx.nonce}`;
  const created = await ctx.api("POST", "/api/agents", {
    body: isLead ? { name, isLead: true } : { name, role: "worker", status: "online" },
  });
  expectStatus(created, [201], `register ${label}`);
  const id = asString(asRecord(created.json).id, `${label} id`);
  const minted = await ctx.api("POST", `/api/agents/${id}/token`, { body: {} });
  expectStatus(minted, [200], `mint ${label} token`);
  return { id, token: asString(asRecord(minted.json).plaintext, `${label} token`) };
}

export const routeCallerIdentity: Scenario = {
  name: "route-caller-identity",
  // Before platform-file-import (690), the suite's last restart: the boot sweep fails
  // in_progress tasks 5 s after a restart, and the strict gate needs that status in the final
  // database, so nothing may run for long after that restart.
  order: 667,
  async run(ctx) {
    const owner = await registerWithToken(ctx, "owner");
    const other = await registerWithToken(ctx, "other");
    const lead = await registerWithToken(ctx, "lead", true);
    const missingAgentId = crypto.randomUUID();
    let scheduleId: string | undefined;
    const endpointPaths: string[] = [];
    const otherMcp = await ctx.connectMcp(other.id, { apiKey: other.token });
    const ownerMcp = await ctx.connectMcp(owner.id, { apiKey: owner.token });

    try {
      // ── script endpoint run-as agent ─────────────────────────────────────────
      const script = await upsertScript(ctx, owner.id, {
        name: `ident-script-${ctx.nonce}`,
        source: `import { z } from "zod";
export const argsSchema = z.object({});
export default async function (_args: z.infer<typeof argsSchema>, _ctx: any) {
  return { ok: true };
}`,
      });
      const apis = `/api/scripts/${script.id}/apis`;
      const create = async (options: { apiKey?: string; agentId?: string }, runAs?: string) => {
        const response = await ctx.api("POST", apis, {
          ...options,
          body: runAs ? { label: "ident", agentId: runAs } : { label: "ident" },
        });
        if (response.status === 201) {
          endpointPaths.push(`${apis}/${asString(asRecord(response.json).id, "endpoint id")}`);
        }
        return response;
      };
      expectStatus(
        await create({ apiKey: owner.token }),
        [403],
        "a worker token creates a script endpoint",
      );
      expectStatus(
        await create({ apiKey: lead.token }, missingAgentId),
        [400],
        "a lead token names an unregistered run-as agent",
      );
      const leadCreated = await create({ apiKey: lead.token }, owner.id);
      expectStatus(leadCreated, [201], "a lead token creates an endpoint for a registered agent");
      expect(asRecord(leadCreated.json).agentId === owner.id, "the endpoint runs as the owner");
      expectStatus(
        await create({ agentId: owner.id }, missingAgentId),
        [201],
        "the shared key keeps its run-as choice",
      );

      // ── manual schedule run ──────────────────────────────────────────────────
      const created = await ctx.api("POST", "/api/schedules", {
        agentId: owner.id,
        body: {
          name: `e2e-ident-sched-${ctx.nonce}`,
          cronExpression: YEARLY,
          taskTemplate: "identity check",
          targetAgentId: owner.id,
        },
      });
      expectStatus(created, [201], "the owner creates a schedule");
      scheduleId = asString(asRecord(created.json).id, "schedule id");
      const runPath = `/api/schedules/${scheduleId}/run`;

      const refused = await ctx.api("POST", runPath, { apiKey: other.token });
      expectStatus(refused, [403], "another agent's token runs the schedule");
      expect(String(asRecord(refused.json).error).includes(RUN_DENIED), "the 403 says why");
      await callToolErr(otherMcp, "run-schedule-now", { scheduleId }, RUN_DENIED);

      expectStatus(
        await ctx.api("POST", runPath, { apiKey: owner.token }),
        [200],
        "the owner's token runs the schedule",
      );
      await callToolOk(ownerMcp, "run-schedule-now", { scheduleId });
      expectStatus(
        await ctx.api("POST", runPath, { apiKey: lead.token }),
        [200],
        "the lead's token runs the schedule",
      );
      expectStatus(
        await ctx.api("POST", runPath, { agentId: other.id }),
        [200],
        "the shared key with another agent's X-Agent-ID runs the schedule",
      );

      // ── memory index owner ───────────────────────────────────────────────────
      const indexBody = (agentId: string, label: string) => ({
        content: `Identity note ${label} ${ctx.nonce}: the heron waits by the water.`,
        name: `Identity note ${label}`,
        scope: "agent",
        source: "manual",
        agentId,
      });
      const memoryRows = (agentId: string) =>
        ctx.db.get<{ n: number }>(
          sql`SELECT COUNT(*) AS n FROM agent_memory WHERE "agentId" = ${agentId} AND name LIKE ${"Identity note %"}`,
        )?.n ?? 0;

      const crossIndex = await ctx.api("POST", "/api/memory/index", {
        apiKey: other.token,
        body: indexBody(owner.id, "cross"),
      });
      expectStatus(crossIndex, [403], "a worker token indexes memory for another agent");
      expect(memoryRows(owner.id) === 0, "the refused index wrote no row");

      expectStatus(
        await ctx.api("POST", "/api/memory/index", {
          apiKey: other.token,
          body: indexBody(other.id, "own"),
        }),
        [202],
        "a worker token indexes its own memory",
      );
      expectStatus(
        await ctx.api("POST", "/api/memory/index", {
          apiKey: lead.token,
          body: indexBody(owner.id, "lead"),
        }),
        [202],
        "a lead token indexes memory for another agent",
      );
      expectStatus(
        await ctx.api("POST", "/api/memory/index", {
          agentId: other.id,
          body: indexBody(owner.id, "shared"),
        }),
        [202],
        "the shared key with an X-Agent-ID indexes memory for another agent",
      );
      expect(memoryRows(owner.id) === 2, "the lead and shared-key indexes wrote the owner's rows");
    } finally {
      for (const path of endpointPaths) await ctx.api("DELETE", path);
      if (scheduleId) await ctx.api("DELETE", `/api/schedules/${scheduleId}`);
      await otherMcp.close();
      await ownerMcp.close();
      for (const agent of [owner, other, lead]) await retireAgent(ctx, agent.id);
    }
  },
};
