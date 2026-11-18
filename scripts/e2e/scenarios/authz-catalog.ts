// A non-lead agent cannot change or run workflows: a workflow script node runs in the API
// process. HTTP and MCP, with a worker session token (`aseph_`), and over the shared key with
// a registered worker id (MCP). A page session counts as the agent that owns the page. The lead
// (by its own `aseph_` token), the operator and a user holding the verb keep every operation;
// validate, reads and the webhook trigger stay open.
import { sql } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  count,
  createUserToken,
  GATE_DENIED,
  launchPageSession,
  mintAgentToken,
} from "./authz-helpers";
import { registerLead, retireAgent } from "./core-helpers";
import { callToolErr, callToolOk, registerWorker, type WorkflowDef } from "./workflow-helpers";

const DEFINITION: WorkflowDef = {
  nodes: [{ id: "tick", type: "script", config: { runtime: "bash", script: "echo ok" } }],
};

export const authzCatalog: Scenario = {
  name: "authz-catalog",
  order: 360,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "authz-catalog");
    const leadId = await registerLead(ctx, "authz-catalog");
    const token = await mintAgentToken(ctx, workerId);
    const leadToken = await mintAgentToken(ctx, leadId);
    const asLead = (method: string, path: string, body?: Record<string, unknown>) =>
      ctx.api(method, path, { apiKey: leadToken, body });
    const pageIds: string[] = [];
    let rbacOn = false;
    const workerMcp = await ctx.connectMcp(workerId, { apiKey: token });
    const keyedWorkerMcp = await ctx.connectMcp(workerId);
    const leadMcp = await ctx.connectMcp(leadId);
    const created: string[] = [];

    const workflowRows = (name: string) =>
      count(ctx, sql`SELECT COUNT(*) AS n FROM workflows WHERE name = ${name}`);
    const runRows = (workflowId: string) =>
      count(ctx, sql`SELECT COUNT(*) AS n FROM workflow_runs WHERE "workflowId" = ${workflowId}`);

    try {
      // A target workflow and a run, made by the lead.
      const targetName = `authz-target-${ctx.nonce}`;
      const target = await asLead("POST", "/api/workflows", {
        name: targetName,
        definition: DEFINITION,
      });
      expectStatus(target, [201], "the lead token creates a workflow over HTTP");
      const workflowId = asString(asRecord(target.json).id, "workflow id");
      created.push(workflowId);
      const run = await asLead("POST", `/api/workflows/${workflowId}/trigger`, {});
      expectStatus(run, [201], "the lead token triggers a workflow over HTTP");
      const runId = asString(asRecord(run.json).runId, "run id");
      const runsBefore = runRows(workflowId);

      // The worker token cannot write or run over HTTP, and nothing changes.
      const deniedName = `authz-denied-${ctx.nonce}`;
      const worker = (method: string, path: string, body?: Record<string, unknown>) =>
        ctx.api(method, path, { apiKey: token, body });
      for (const [label, response] of [
        [
          "create",
          await worker("POST", "/api/workflows", { name: deniedName, definition: DEFINITION }),
        ],
        ["put", await worker("PUT", `/api/workflows/${workflowId}`, { description: "worker" })],
        ["patch", await worker("PATCH", `/api/workflows/${workflowId}`, { delete: ["tick"] })],
        [
          "patch node",
          await worker("PATCH", `/api/workflows/${workflowId}/nodes/tick`, { label: "worker" }),
        ],
        ["delete", await worker("DELETE", `/api/workflows/${workflowId}`)],
        ["trigger", await worker("POST", `/api/workflows/${workflowId}/trigger`, {})],
        ["retry", await worker("POST", `/api/workflow-runs/${runId}/retry`)],
        ["cancel", await worker("POST", `/api/workflow-runs/${runId}/cancel`, {})],
        ["run event", await worker("POST", `/api/workflow-runs/${runId}/events`, { name: "x.y" })],
        ["global event", await worker("POST", "/api/workflow-events", { name: "x.y" })],
      ] as const) {
        expectStatus(response, [403], `worker token ${label}`);
      }
      expect(workflowRows(deniedName) === 0, "the denied create left no workflow row");
      expect(runRows(workflowId) === runsBefore, "the denied trigger started no run");
      expect(workflowRows(targetName) === 1, "the denied delete kept the workflow");
      expect(
        ctx.db.get<{ description: string | null }>(
          sql`SELECT description FROM workflows WHERE id = ${workflowId}`,
        )?.description !== "worker",
        "the denied update changed nothing",
      );

      // Open surfaces stay open to the worker token.
      expectStatus(
        await worker("POST", `/api/workflows/${workflowId}/trigger/validate`, {}),
        [200],
        "worker token validate",
      );
      expectStatus(await worker("GET", `/api/workflows/${workflowId}`), [200], "worker token get");

      // MCP: the worker token and the shared key with a registered worker id are both denied.
      for (const [who, connection] of [
        ["worker token", workerMcp],
        ["keyed worker", keyedWorkerMcp],
      ] as const) {
        const denied = "requires the lead agent, operator, or user";
        await callToolErr(
          connection,
          "create-workflow",
          { name: deniedName, definition: DEFINITION },
          denied,
        );
        await callToolErr(connection, "update-workflow", { id: workflowId, name: "x" }, denied);
        await callToolErr(
          connection,
          "patch-workflow",
          { id: workflowId, delete: ["tick"] },
          denied,
        );
        await callToolErr(
          connection,
          "patch-workflow-node",
          { id: workflowId, nodeId: "tick", label: "x" },
          denied,
        );
        await callToolErr(connection, "delete-workflow", { id: workflowId }, denied);
        await callToolErr(connection, "trigger-workflow", { id: workflowId }, denied);
        await callToolErr(connection, "retry-workflow-run", { runId }, denied);
        await callToolErr(connection, "cancel-workflow-run", { runId }, denied);
        expect(workflowRows(deniedName) === 0, `${who} create-workflow left no row`);
        expect(runRows(workflowId) === runsBefore, `${who} trigger-workflow started no run`);
      }

      // The lead keeps every tool.
      const mcpName = `authz-mcp-${ctx.nonce}`;
      const mcpCreated = await callToolOk(leadMcp, "create-workflow", {
        name: mcpName,
        definition: DEFINITION,
      });
      const mcpId = asString(
        asRecord(mcpCreated.structured.workflow).id,
        "lead-created workflow id",
      );
      created.push(mcpId);
      await callToolOk(leadMcp, "update-workflow", { id: mcpId, description: "lead" });
      await callToolOk(leadMcp, "patch-workflow-node", { id: mcpId, nodeId: "tick", label: "t" });
      await callToolOk(leadMcp, "patch-workflow", { id: mcpId, update: [] });
      await callToolOk(leadMcp, "trigger-workflow", { id: mcpId });
      await callToolOk(leadMcp, "delete-workflow", { id: mcpId });
      created.pop();

      // The operator (shared key, no agent) keeps HTTP.
      const opName = `authz-op-${ctx.nonce}`;
      const opCreated = await ctx.api("POST", "/api/workflows", {
        body: { name: opName, definition: DEFINITION },
      });
      expectStatus(opCreated, [201], "the operator creates a workflow");
      const opId = asString(asRecord(opCreated.json).id, "operator workflow id");
      created.push(opId);
      expectStatus(
        await ctx.api("POST", `/api/workflows/${opId}/trigger`, { body: {} }),
        [201],
        "the operator triggers a workflow",
      );
      expectStatus(
        await ctx.api("PUT", `/api/workflows/${opId}`, { body: { description: "operator" } }),
        [200],
        "the operator updates a workflow",
      );
      expectStatus(
        await ctx.api("POST", "/api/workflow-events", { body: { name: "authz.signal" } }),
        [200],
        "the operator signals a global event",
      );
      expectStatus(
        await asLead("POST", `/api/workflows/${workflowId}/trigger`, {}),
        [201],
        "the lead token triggers a workflow over HTTP again",
      );
      expectStatus(
        await asLead("POST", "/api/workflow-events", { name: "authz.signal" }),
        [200],
        "the lead token signals a global event",
      );

      // ── Page sessions are judged as the agent that owns the page ──────────────────────────
      // A page's code is agent-authored and the page proxy forwards /api/*, so a viewer's
      // operator or user identity must not widen what a worker's page may do.
      const user = await createUserToken(ctx, "authz-page-viewer", "admin");
      const workerPageName = `authz-page-worker-${ctx.nonce}`;
      const leadPageName = `authz-page-lead-${ctx.nonce}`;
      for (const [viewerLabel, viewer] of [
        ["operator", {}],
        ["user", { apiKey: user.token }],
      ] as const) {
        const workerPage = await launchPageSession(
          ctx,
          workerId,
          viewer,
          `worker-${viewerLabel}`,
          pageIds,
        );
        const leadPage = await launchPageSession(
          ctx,
          leadId,
          viewer,
          `lead-${viewerLabel}`,
          pageIds,
        );
        const makeName = (base: string) => `${base}-${viewerLabel}`;
        expectStatus(
          await ctx.api("POST", "/@swarm/api/workflows", {
            ...workerPage,
            body: { name: makeName(workerPageName), definition: DEFINITION },
          }),
          [403],
          `a worker's page launched by the ${viewerLabel} creates a workflow`,
        );
        expect(
          workflowRows(makeName(workerPageName)) === 0,
          `the worker page (${viewerLabel}) left no workflow row`,
        );
        const runsNow = runRows(workflowId);
        expectStatus(
          await ctx.api("POST", `/@swarm/api/workflows/${workflowId}/trigger`, {
            ...workerPage,
            body: {},
          }),
          [403],
          `a worker's page launched by the ${viewerLabel} triggers a workflow`,
        );
        expect(runRows(workflowId) === runsNow, "the denied page trigger started no run");
        const bridgeDenied = await ctx.api("POST", "/@swarm/api/mcp-bridge", {
          ...workerPage,
          body: {
            tool: "create-workflow",
            args: { name: makeName(`${workerPageName}-bridge`), definition: DEFINITION },
          },
        });
        expectStatus(bridgeDenied, [200], "bridge create-workflow from a worker page");
        expect(
          asRecord(bridgeDenied.json).success === false && bridgeDenied.text.includes(GATE_DENIED),
          `the bridge refused a worker page: ${bridgeDenied.text.slice(0, 300)}`,
        );
        expect(
          workflowRows(makeName(`${workerPageName}-bridge`)) === 0,
          "the bridge call from a worker page left no workflow row",
        );

        const leadCreated = await ctx.api("POST", "/@swarm/api/workflows", {
          ...leadPage,
          body: { name: makeName(leadPageName), definition: DEFINITION },
        });
        expectStatus(leadCreated, [201], `a lead's page launched by the ${viewerLabel} creates`);
        created.push(asString(asRecord(leadCreated.json).id, "lead page workflow id"));
        expectStatus(
          await ctx.api("POST", `/@swarm/api/workflows/${workflowId}/trigger`, {
            ...leadPage,
            body: {},
          }),
          [201],
          `a lead's page launched by the ${viewerLabel} triggers`,
        );
      }

      // ── A user token: no grant is refused, a grant passes (RBAC on) ───────────────────────
      const viewerUser = await createUserToken(ctx, "authz-viewer", "viewer");
      const adminUser = await createUserToken(ctx, "authz-admin", "admin");
      // The e2e API boots with RBAC off, which grants every user everything.
      rbacOn = true;
      await ctx.restartSut({ env: { RBAC_ENABLED: "true" } });
      const viewerName = `authz-viewer-${ctx.nonce}`;
      const adminName = `authz-admin-${ctx.nonce}`;
      const asUser = (
        token: string,
        method: string,
        path: string,
        body?: Record<string, unknown>,
      ) => ctx.api(method, path, { apiKey: token, body });
      expectStatus(
        await asUser(viewerUser.token, "POST", "/api/workflows", {
          name: viewerName,
          definition: DEFINITION,
        }),
        [403],
        "a user without the workflow write grant creates a workflow",
      );
      expect(workflowRows(viewerName) === 0, "the denied user create left no workflow row");
      expectStatus(
        await asUser(viewerUser.token, "POST", `/api/workflows/${workflowId}/trigger`, {}),
        [403],
        "a user without the workflow run grant triggers a workflow",
      );
      const adminCreated = await asUser(adminUser.token, "POST", "/api/workflows", {
        name: adminName,
        definition: DEFINITION,
      });
      expectStatus(adminCreated, [201], "a user with every grant creates a workflow");
      created.push(asString(asRecord(adminCreated.json).id, "admin workflow id"));
      expectStatus(
        await asUser(adminUser.token, "POST", `/api/workflows/${workflowId}/trigger`, {}),
        [201],
        "a user with every grant triggers a workflow",
      );
    } finally {
      for (const id of created) await ctx.api("DELETE", `/api/workflows/${id}`);
      for (const id of pageIds) await ctx.api("DELETE", `/api/pages/${id}`);
      // A restart for the RBAC block drops the MCP sessions.
      await workerMcp.close().catch(() => {});
      await keyedWorkerMcp.close().catch(() => {});
      await leadMcp.close().catch(() => {});
      if (rbacOn) await ctx.restartSut();
      await retireAgent(ctx, leadId);
    }
  },
};
