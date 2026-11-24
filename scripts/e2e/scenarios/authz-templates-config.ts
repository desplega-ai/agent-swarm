// A non-lead agent can change only its own agent-scoped templates, not shared templates or
// schedules, and cannot reload config. Exercise HTTP with a
// worker session token (`aseph_`), MCP, and a page session (judged as the agent that owns the
// page), against a lead (its own `aseph_` token), the operator and a user holding the verb.
// Render, preview and reads stay open.
import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario } from "../run";
import {
  count,
  createUserToken,
  GATE_DENIED,
  launchPageSession,
  mintAgentToken,
} from "./authz-helpers";
import { registerLead, retireAgent } from "./core-helpers";
import { callToolErr, callToolOk, registerWorker } from "./workflow-helpers";

// 03:00 on 1 January: never due while the suite runs.
const YEARLY = "0 3 1 1 *";
const DENIED = GATE_DENIED;

export const authzTemplatesConfig: Scenario = {
  name: "authz-templates-config",
  order: 361,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "authz-tc");
    const pageIds: string[] = [];
    let rbacOn = false;
    let workerMcp: McpConnection | undefined;
    let keyedWorkerMcp: McpConnection | undefined;
    let leadMcp: McpConnection | undefined;
    const cleanupSchedules: string[] = [];
    const cleanupTemplates = new Set<string>();

    const scheduleRows = (name: string) =>
      count(ctx, sql`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE name = ${name}`);

    const leadId = await registerLead(ctx, "authz-tc");
    try {
      const token = await mintAgentToken(ctx, workerId);
      const leadToken = await mintAgentToken(ctx, leadId);
      const worker = (method: string, path: string, body?: Record<string, unknown>) =>
        ctx.api(method, path, { apiKey: token, body });
      const lead = (method: string, path: string, body?: Record<string, unknown>) =>
        ctx.api(method, path, { apiKey: leadToken, body });
      workerMcp = await ctx.connectMcp(workerId, { apiKey: token });
      keyedWorkerMcp = await ctx.connectMcp(workerId);
      leadMcp = await ctx.connectMcp(leadId);

      const eventType = `e2e.authz-tc.${ctx.nonce}`;
      const override = (scopeId: string, body: string) => ({
        eventType,
        scope: "agent",
        scopeId,
        body,
      });

      // ── Prompt templates over HTTP ──────────────────────────────────────────────────────
      // The lead creates an override the worker then tries to change.
      const created = await lead(
        "PUT",
        "/api/prompt-templates",
        override(leadId, "lead override {{marker}}"),
      );
      expectStatus(created, [200], "the lead token creates an override");
      const templateId = asString(asRecord(asRecord(created.json).template).id, "template id");
      cleanupTemplates.add(templateId);

      const own = await worker(
        "PUT",
        "/api/prompt-templates",
        override(workerId, "worker override"),
      );
      expectStatus(own, [200], "worker token PUT own prompt template");
      const ownId = asString(asRecord(asRecord(own.json).template).id, "worker template id");
      cleanupTemplates.add(ownId);
      expectStatus(
        await worker("POST", `/api/prompt-templates/${ownId}/checkout`, { version: 1 }),
        [200],
        "worker token checks out its own prompt template",
      );
      const reset = await worker("POST", `/api/prompt-templates/${ownId}/reset`);
      expectStatus(reset, [404], "worker token reaches reset for its own custom template");
      expect(
        asString(asRecord(reset.json).error, "reset error").includes("No code default"),
        "the template cannot be reset because it has no code default, not because of permissions",
      );
      const foreignOverride = override(leadId, "worker override");
      const repoOverride = {
        ...override(crypto.randomUUID(), "worker repo override"),
        scope: "repo",
      };
      for (const template of [foreignOverride, repoOverride]) {
        expectStatus(
          await worker("PUT", "/api/prompt-templates", template),
          [403],
          `worker token cannot PUT a ${template.scope} template it does not own`,
        );
      }
      for (const [label, response] of [
        [
          "checkout",
          await worker("POST", `/api/prompt-templates/${templateId}/checkout`, { version: 1 }),
        ],
        ["reset", await worker("POST", `/api/prompt-templates/${templateId}/reset`)],
        ["delete", await worker("DELETE", `/api/prompt-templates/${templateId}`)],
      ] as const) {
        expectStatus(response, [403], `worker token ${label} prompt template`);
      }
      expect(
        count(ctx, sql`SELECT COUNT(*) AS n FROM prompt_templates WHERE id = ${templateId}`) === 1,
        "the denied delete kept the template",
      );
      // Render and preview stay open to the worker.
      expectStatus(
        await worker("POST", "/api/prompt-templates/preview", { eventType }),
        [200],
        "worker token preview",
      );
      expectStatus(await worker("GET", "/api/prompt-templates"), [200], "worker token list");

      // ── Prompt templates over MCP ───────────────────────────────────────────────────────
      for (const connection of [workerMcp, keyedWorkerMcp]) {
        await callToolOk(connection, "set-prompt-template", override(workerId, "worker mcp"));
        await callToolErr(connection, "set-prompt-template", foreignOverride, "Only a lead");
        await callToolErr(connection, "set-prompt-template", repoOverride, "Only a lead");
        await callToolErr(connection, "delete-prompt-template", { id: templateId }, "Only a lead");
      }
      await callToolOk(leadMcp, "set-prompt-template", {
        eventType,
        scope: "agent",
        scopeId: leadId,
        body: "lead mcp override",
      });
      await callToolOk(leadMcp, "delete-prompt-template", { id: templateId });
      cleanupTemplates.delete(templateId);
      const operatorTemplate = await ctx.api("PUT", "/api/prompt-templates", {
        agentId: workerId,
        body: override(leadId, "operator override"),
      });
      expectStatus(operatorTemplate, [200], "direct HTTP operator with worker header may upsert");
      cleanupTemplates.add(
        asString(asRecord(asRecord(operatorTemplate.json).template).id, "operator template id"),
      );

      // ── Schedules ───────────────────────────────────────────────────────────────────────
      const deniedName = `authz-sched-denied-${ctx.nonce}`;
      const leadName = `authz-sched-lead-${ctx.nonce}`;
      const leadSchedule = await lead("POST", "/api/schedules", {
        name: leadName,
        cronExpression: YEARLY,
        taskTemplate: "lead work",
      });
      expectStatus(leadSchedule, [201], "the lead token creates a schedule");
      const scheduleId = asString(asRecord(leadSchedule.json).id, "schedule id");
      cleanupSchedules.push(scheduleId);

      for (const [label, response] of [
        [
          "create",
          await worker("POST", "/api/schedules", {
            name: deniedName,
            cronExpression: YEARLY,
            taskTemplate: "worker work",
          }),
        ],
        ["put", await worker("PUT", `/api/schedules/${scheduleId}`, { description: "worker" })],
        ["patch", await worker("PATCH", `/api/schedules/${scheduleId}`, { description: "worker" })],
        ["run", await worker("POST", `/api/schedules/${scheduleId}/run`)],
        ["delete", await worker("DELETE", `/api/schedules/${scheduleId}`)],
      ] as const) {
        expectStatus(response, [403], `worker token schedule ${label}`);
      }
      expect(scheduleRows(deniedName) === 0, "the denied create stored no schedule");
      expect(scheduleRows(leadName) === 1, "the denied delete kept the schedule");
      expect(
        count(
          ctx,
          sql`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE id = ${scheduleId} AND description IS DISTINCT FROM 'worker'`,
        ) === 1,
        "the denied update changed nothing",
      );
      expectStatus(await worker("GET", `/api/schedules/${scheduleId}`), [200], "worker token get");

      for (const [who, connection] of [
        ["worker token", workerMcp],
        ["keyed worker", keyedWorkerMcp],
      ] as const) {
        await callToolErr(
          connection,
          "create-schedule",
          { name: deniedName, cronExpression: YEARLY, taskTemplate: "worker work" },
          DENIED,
        );
        await callToolErr(
          connection,
          "update-schedule",
          { scheduleId, description: "worker mcp", enabled: false },
          DENIED,
        );
        await callToolErr(
          connection,
          "patch-schedule",
          { scheduleId, cronExpression: "0 5 1 1 *" },
          DENIED,
        );
        expect(
          count(
            ctx,
            sql`SELECT COUNT(*) AS n FROM scheduled_tasks WHERE id = ${scheduleId} AND enabled AND "cronExpression" = ${YEARLY} AND description IS DISTINCT FROM 'worker mcp'`,
          ) === 1,
          `${who} update-schedule and patch-schedule changed nothing`,
        );
        await callToolErr(connection, "run-schedule-now", { scheduleId }, DENIED);
        await callToolErr(connection, "delete-schedule", { scheduleId }, DENIED);
        expect(scheduleRows(deniedName) === 0, `${who} create-schedule stored nothing`);
        expect(scheduleRows(leadName) === 1, `${who} delete-schedule kept the schedule`);
      }

      const mcpName = `authz-sched-mcp-${ctx.nonce}`;
      await callToolOk(leadMcp, "create-schedule", {
        name: mcpName,
        cronExpression: YEARLY,
        taskTemplate: "lead mcp work",
      });
      await callToolOk(leadMcp, "delete-schedule", { name: mcpName });
      expect(scheduleRows(mcpName) === 0, "the lead deleted its schedule over MCP");
      expectStatus(
        await ctx.api("PUT", `/api/schedules/${scheduleId}`, { body: { description: "operator" } }),
        [200],
        "the operator updates a schedule",
      );
      expectStatus(
        await lead("PATCH", `/api/schedules/${scheduleId}`, { description: "lead" }),
        [200],
        "the lead token patches a schedule",
      );

      // ── Config reload ───────────────────────────────────────────────────────────────────
      expectStatus(await worker("POST", "/api/config/reload"), [403], "worker token config reload");
      const internal = await ctx.api("POST", "/internal/reload-config", { apiKey: token });
      expectStatus(internal, [403], "worker token internal reload");
      expectStatus(
        await lead("POST", "/api/config/reload"),
        [200],
        "the lead token reloads config",
      );
      const operatorReload = await ctx.api("POST", "/internal/reload-config");
      expectStatus(operatorReload, [200], "the operator reloads config internally");
      const reloadResult = asRecord(operatorReload.json);
      expect(
        reloadResult.success === true &&
          typeof reloadResult.configsLoaded === "number" &&
          Array.isArray(reloadResult.keysUpdated) &&
          Array.isArray(reloadResult.integrationsReinitialized),
        "internal reload keeps the success response contract",
      );

      // ── Page sessions are judged as the agent that owns the page ──────────────────────────
      const adminUser = await createUserToken(ctx, "authz-tc-admin", "admin");
      const viewerUser = await createUserToken(ctx, "authz-tc-viewer", "viewer");
      const pagedName = `authz-sched-page-${ctx.nonce}`;
      for (const [viewerLabel, viewer] of [
        ["operator", {}],
        ["user", { apiKey: adminUser.token }],
      ] as const) {
        const workerPage = await launchPageSession(
          ctx,
          workerId,
          viewer,
          `tc-worker-${viewerLabel}`,
          pageIds,
        );
        const leadPage = await launchPageSession(
          ctx,
          leadId,
          viewer,
          `tc-lead-${viewerLabel}`,
          pageIds,
        );
        const label = `${viewerLabel}-launched`;
        expectStatus(
          await ctx.api("PUT", "/@swarm/api/prompt-templates", {
            ...workerPage,
            body: override(workerId, "worker page override"),
          }),
          [200],
          `a worker page (${label}) can PUT its owner's own prompt template`,
        );
        expectStatus(
          await ctx.api("PUT", "/@swarm/api/prompt-templates", {
            ...workerPage,
            body: override(leadId, "worker page override"),
          }),
          [403],
          `a worker page (${label}) cannot PUT another agent's prompt template`,
        );
        expectStatus(
          await ctx.api("POST", "/@swarm/api/schedules", {
            ...workerPage,
            body: { name: pagedName, cronExpression: YEARLY, taskTemplate: "page work" },
          }),
          [403],
          `a worker page (${label}) creates a schedule`,
        );
        expect(scheduleRows(pagedName) === 0, `the worker page (${label}) stored no schedule`);
        expectStatus(
          await ctx.api("POST", "/@swarm/api/config/reload", { ...workerPage, body: {} }),
          [403],
          `a worker page (${label}) reloads config`,
        );
        const leadPageSchedule = await ctx.api("POST", "/@swarm/api/schedules", {
          ...leadPage,
          body: { name: `${pagedName}-${viewerLabel}`, cronExpression: YEARLY, taskTemplate: "x" },
        });
        expectStatus(leadPageSchedule, [201], `a lead page (${label}) creates a schedule`);
        cleanupSchedules.push(asString(asRecord(leadPageSchedule.json).id, "page schedule id"));
        expectStatus(
          await ctx.api("POST", "/@swarm/api/config/reload", { ...leadPage, body: {} }),
          [200],
          `a lead page (${label}) reloads config`,
        );
      }
      expectStatus(
        await worker("DELETE", `/api/prompt-templates/${ownId}`),
        [200],
        "worker token deletes its own prompt template",
      );
      cleanupTemplates.delete(ownId);

      // ── A user token: no grant is refused, a grant passes (RBAC on) ───────────────────────
      // The e2e API boots with RBAC off, which grants every user everything.
      rbacOn = true;
      await ctx.restartSut({ env: { RBAC_ENABLED: "true" } });
      const userName = `authz-sched-user-${ctx.nonce}`;
      const asUser = (
        token: string,
        method: string,
        path: string,
        body?: Record<string, unknown>,
      ) => ctx.api(method, path, { apiKey: token, body });
      expectStatus(
        await asUser(viewerUser.token, "POST", "/api/schedules", {
          name: userName,
          cronExpression: YEARLY,
          taskTemplate: "user work",
        }),
        [403],
        "a user without the schedule grant creates a schedule",
      );
      expect(scheduleRows(userName) === 0, "the denied user create stored no schedule");
      expectStatus(
        await asUser(viewerUser.token, "PUT", "/api/prompt-templates", override(leadId, "user")),
        [403],
        "a user without the template grant PUT prompt template",
      );
      expectStatus(
        await asUser(viewerUser.token, "POST", "/api/config/reload"),
        [403],
        "a user without the reload grant reloads config",
      );
      expectStatus(
        await asUser(viewerUser.token, "POST", "/internal/reload-config"),
        [403],
        "a user without config.reload cannot reload config internally",
      );
      expectStatus(
        await asUser(adminUser.token, "POST", "/internal/reload-config"),
        [200],
        "a grant-all user can reload config internally",
      );
      const userSchedule = await asUser(adminUser.token, "POST", "/api/schedules", {
        name: userName,
        cronExpression: YEARLY,
        taskTemplate: "user work",
      });
      expectStatus(userSchedule, [201], "a user with every grant creates a schedule");
      cleanupSchedules.push(asString(asRecord(userSchedule.json).id, "user schedule id"));
      expectStatus(
        await asUser(adminUser.token, "PUT", "/api/prompt-templates", override(leadId, "user")),
        [200],
        "a user with every grant PUT prompt template",
      );
      expectStatus(
        await asUser(adminUser.token, "POST", "/api/config/reload"),
        [200],
        "a user with every grant reloads config",
      );
    } finally {
      try {
        for (const id of cleanupSchedules) await ctx.api("DELETE", `/api/schedules/${id}`);
        for (const id of cleanupTemplates) await ctx.api("DELETE", `/api/prompt-templates/${id}`);
        for (const id of pageIds) await ctx.api("DELETE", `/api/pages/${id}`);
      } finally {
        try {
          // A restart for the RBAC block drops the MCP sessions.
          await Promise.all([
            retireAgent(ctx, leadId),
            workerMcp?.close().catch(() => {}),
            keyedWorkerMcp?.close().catch(() => {}),
            leadMcp?.close().catch(() => {}),
          ]);
        } finally {
          if (rbacOn) await ctx.restartSut();
        }
      }
    }
  },
};
