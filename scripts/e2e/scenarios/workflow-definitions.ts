// Workflow definitions over HTTP and MCP: create/list/get/update/patch/delete, version
// history, executor types, trigger payload validation, and the authoring errors each
// surface answers with. Run behaviour lives in workflow-engine-*.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  createWorkflow,
  registerWorker,
  triggerWorkflow,
  type WorkflowDef,
  waitForRun,
} from "./workflow-helpers";

const ALL_EXECUTOR_TYPES = [
  "agent-task",
  "code-match",
  "foreach",
  "human-in-the-loop",
  "notify",
  "property-match",
  "raw-llm",
  "script",
  "sub-workflow",
  "swarm-script",
  "system-one-decision",
  "system-one-extraction",
  "validate",
  "vcs",
  "wait",
];
// system-one-decision parks when `humanReview` sends an answer to a person.
const ASYNC_EXECUTOR_TYPES = [
  "agent-task",
  "foreach",
  "human-in-the-loop",
  "sub-workflow",
  "system-one-decision",
  "wait",
];

function bash(id: string, text: string, next?: WorkflowDef["nodes"][number]["next"]) {
  return { id, type: "script", config: { runtime: "bash", script: `echo ${text}` }, next };
}

export const workflowDefinitions: Scenario = {
  name: "workflow-definitions",
  order: 300,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "wf-defs");
    const marker = `defs-${ctx.nonce}`;
    const created: string[] = [];

    // ── executor types ────────────────────────────────────────────────────────
    const types = await ctx.api("GET", "/api/executor-types");
    expectStatus(types, [200], "list executor types");
    const typeList = asRecords(types.json, "executorTypes");
    const byType = new Map(typeList.map((entry) => [String(entry.type), entry]));
    for (const type of ALL_EXECUTOR_TYPES) {
      expect(byType.has(type), `executor type ${type} is not registered`);
    }
    for (const entry of typeList) {
      expect(
        entry.mode === "instant" || entry.mode === "async",
        `executor ${String(entry.type)} has mode ${String(entry.mode)}`,
      );
      expect(
        typeof asRecord(entry.configSchema) === "object" &&
          typeof asRecord(entry.outputSchema) === "object",
        `executor ${String(entry.type)} has config and output schemas`,
      );
    }
    for (const type of ALL_EXECUTOR_TYPES) {
      const expected = ASYNC_EXECUTOR_TYPES.includes(type) ? "async" : "instant";
      expect(byType.get(type)?.mode === expected, `executor ${type} is ${expected}`);
    }
    const one = await ctx.api("GET", "/api/executor-types/wait");
    expectStatus(one, [200], "get one executor type");
    expect(
      asRecord(one.json).type === "wait" && asRecord(one.json).mode === "async",
      "get one executor type",
    );
    expect(
      JSON.stringify(asRecord(asRecord(one.json).configSchema)).includes("durationMs"),
      "wait config schema describes durationMs",
    );
    expectStatus(
      await ctx.api("GET", "/api/executor-types/no-such-executor"),
      [404],
      "unknown executor type",
    );

    // ── create: authoring errors ──────────────────────────────────────────────
    const invalid: Array<[string, unknown, string]> = [
      [
        "unregistered executor type",
        { nodes: [{ id: "a", type: "no-such-executor", config: {} }] },
        "unregistered executor type",
      ],
      [
        "dangling next",
        { nodes: [{ ...bash("a", "x"), next: "ghost" }] },
        "non-existent next target",
      ],
      ["two entry nodes", { nodes: [bash("a", "x"), bash("b", "y")] }, "Multiple entry nodes"],
      ["reserved # in a node id", { nodes: [bash("a#1", "x")] }, "reserved character"],
      [
        "agent-task without a template",
        { nodes: [{ id: "a", type: "agent-task", config: {} }] },
        "template",
      ],
      [
        "input from a node that is not upstream",
        { nodes: [{ ...bash("a", "x", "b") }, { ...bash("b", "y"), inputs: { z: "zzz" } }] },
        "non-existent node",
      ],
    ];
    for (const [label, definition, needle] of invalid) {
      const response = await ctx.api("POST", "/api/workflows", {
        body: { name: `bad-${ctx.nonce}`, definition },
      });
      expectStatus(response, [400], `create with ${label}`);
      expect(
        String(asRecord(response.json).error).includes(needle),
        `create with ${label}: error should mention "${needle}", got ${response.text.slice(0, 300)}`,
      );
    }
    expectStatus(
      await ctx.api("POST", "/api/workflows", {
        body: { name: "", definition: { nodes: [bash("a", "x")] } },
      }),
      [400],
      "create with an empty name",
    );
    expectStatus(
      await ctx.api("POST", "/api/workflows", { body: { name: "x", definition: { nodes: [] } } }),
      [400],
      "create with no nodes",
    );
    expectStatus(
      await ctx.api("POST", "/api/workflows", {
        apiKey: null,
        body: { name: "x", definition: { nodes: [bash("a", "x")] } },
      }),
      [401],
      "create without credentials",
    );

    // ── create: the full shape round-trips ────────────────────────────────────
    const triggerSchema = {
      type: "object",
      required: ["pr"],
      properties: {
        pr: { type: "object", required: ["number"], properties: { number: { type: "number" } } },
      },
    };
    const original: WorkflowDef = {
      nodes: [bash("first", "one", "second"), bash("second", "two")],
    };
    const createResponse = await ctx.api("POST", "/api/workflows", {
      agentId: workerId,
      body: {
        name: `wf-defs-${ctx.nonce}`,
        description: `description ${marker}`,
        definition: original,
        triggers: [{ type: "webhook", hmacSecret: `e2e-secret-${ctx.nonce}` }],
        cooldown: { seconds: 1 },
        input: { GREETING: `hello-${marker}` },
        triggerSchema,
        dir: "/tmp",
        vcsRepo: "desplega-ai/e2e",
      },
    });
    expectStatus(createResponse, [201], "create the full workflow");
    const workflow = asRecord(createResponse.json);
    const id = asString(workflow.id, "workflow id");
    created.push(id);
    expect(workflow.name === `wf-defs-${ctx.nonce}`, "workflow name");
    expect(workflow.description === `description ${marker}`, "workflow description");
    expect(workflow.enabled === true, "a new workflow is enabled");
    expect(workflow.createdByAgentId === workerId, "created-by agent comes from X-Agent-ID");
    expect(
      String(workflow.key).startsWith("shared/"),
      `default asset key is under shared/, got ${String(workflow.key)}`,
    );
    expect(
      asRecord(workflow.cooldown).seconds === 1 &&
        asRecord(workflow.input).GREETING === `hello-${marker}` &&
        workflow.dir === "/tmp" &&
        workflow.vcsRepo === "desplega-ai/e2e",
      "cooldown, input, dir and vcsRepo round-trip",
    );
    expect(asRecords({ t: workflow.triggers }, "t")[0]?.type === "webhook", "trigger round-trips");
    expect(workflow.warnings === undefined, "a clean workflow carries no save warnings");
    const row = ctx.db.get<{ name: string; enabled: number; createdByAgentId: string }>(
      "SELECT name, enabled, createdByAgentId FROM workflows WHERE id = ?",
      [id],
    );
    expect(row?.name === workflow.name && row.enabled === 1, "workflow row persisted");

    // ── get ───────────────────────────────────────────────────────────────────
    const got = await ctx.api("GET", `/api/workflows/${id}`);
    expectStatus(got, [200], "get workflow");
    const gotJson = asRecord(got.json);
    expect(gotJson.id === id && typeof gotJson.favorite === "boolean", "get workflow shape");
    const edges = asRecords(gotJson, "edges");
    expect(
      edges.length === 1 && edges[0]?.source === "first" && edges[0]?.target === "second",
      `get workflow derives edges from next: ${JSON.stringify(edges)}`,
    );
    expectStatus(
      await ctx.api("GET", `/api/workflows/${crypto.randomUUID()}`),
      [404],
      "get an unknown workflow",
    );

    // ── list: slim by default, full on request, filters ───────────────────────
    const slim = await ctx.api(
      "GET",
      `/api/workflows?q=${encodeURIComponent(`wf-defs-${ctx.nonce}`)}`,
    );
    expectStatus(slim, [200], "list workflows");
    expect(Array.isArray(slim.json), "list workflows returns an array");
    const slimRows = (slim.json as Record<string, unknown>[]).map(asRecord);
    expect(slimRows.length === 1 && slimRows[0]?.id === id, "q matches the workflow by name");
    expect(
      slimRows[0]?.nodeCount === 2 && !("definition" in (slimRows[0] ?? {})),
      "slim rows carry nodeCount and no definition",
    );
    const full = await ctx.api(
      "GET",
      `/api/workflows?fields=full&q=${encodeURIComponent(`description ${marker}`)}`,
    );
    expectStatus(full, [200], "list workflows, full");
    const fullRows = (full.json as Record<string, unknown>[]).map(asRecord);
    expect(
      fullRows.length === 1 && "definition" in (fullRows[0] ?? {}),
      "q also matches the description; fields=full restores the definition",
    );
    const ownKey = String(workflow.key);
    const byKey = await ctx.api("GET", `/api/workflows?key=${encodeURIComponent(ownKey)}`);
    expectStatus(byKey, [200], "list workflows by exact key");
    expect(
      (byKey.json as Record<string, unknown>[]).some((entry) => entry.id === id),
      "key filter finds the workflow",
    );
    const byPrefix = await ctx.api("GET", "/api/workflows?keyPrefix=shared/&limit=500");
    expectStatus(byPrefix, [200], "list workflows by key prefix");
    expect(
      (byPrefix.json as Record<string, unknown>[]).some((entry) => entry.id === id),
      "keyPrefix filter finds the workflow",
    );
    const limited = await ctx.api("GET", "/api/workflows?limit=1");
    expectStatus(limited, [200], "list workflows with a limit");
    expect((limited.json as unknown[]).length === 1, "limit caps the list");
    expectStatus(
      await ctx.api("GET", "/api/workflows?lastRunStatus=bogus"),
      [400],
      "list workflows with a bad lastRunStatus",
    );

    // ── update (PUT): versions, enabled, null clears ──────────────────────────
    const versionsBefore = await ctx.api("GET", `/api/workflows/${id}/versions`);
    expectStatus(versionsBefore, [200], "list versions");
    const before = asRecords(versionsBefore.json, "versions").length;

    const revised: WorkflowDef = {
      nodes: [
        bash("first", "uno", "second"),
        bash("second", "dos", "third"),
        bash("third", "tres"),
      ],
    };
    const put = await ctx.api("PUT", `/api/workflows/${id}`, {
      agentId: workerId,
      body: {
        name: `wf-defs-renamed-${ctx.nonce}`,
        description: "second description",
        definition: revised,
      },
    });
    expectStatus(put, [200], "update workflow");
    const putJson = asRecord(put.json);
    expect(putJson.name === `wf-defs-renamed-${ctx.nonce}`, "update renamed the workflow");
    expect(
      asRecords(asRecord(putJson.definition), "nodes").length === 3,
      "update replaced the definition",
    );
    expect(asRecord(putJson.cooldown).seconds === 1, "fields not in the body stay as they were");
    expectStatus(
      await ctx.api("PUT", `/api/workflows/${id}`, {
        body: { definition: { nodes: [{ ...bash("a", "x"), next: "ghost" }] } },
      }),
      [400],
      "update with an invalid definition",
    );
    expectStatus(
      await ctx.api("PUT", `/api/workflows/${crypto.randomUUID()}`, { body: { name: "x" } }),
      [404],
      "update an unknown workflow",
    );

    const versions = await ctx.api("GET", `/api/workflows/${id}/versions`);
    expectStatus(versions, [200], "list versions after update");
    const versionRows = asRecords(versions.json, "versions");
    expect(versionRows.length === before + 1, `one version per update, got ${versionRows.length}`);
    const newest = asRecord(versionRows[0]);
    expect(
      typeof newest.version === "number" && newest.changedByAgentId === workerId,
      "newest version first, with the changing agent",
    );
    const oldSnapshot = asRecord(newest.snapshot);
    expect(
      oldSnapshot.name === `wf-defs-${ctx.nonce}` &&
        asRecords(asRecord(oldSnapshot.definition), "nodes").length === 2,
      "the snapshot keeps the pre-update state",
    );
    const oneVersion = await ctx.api("GET", `/api/workflows/${id}/versions/${newest.version}`);
    expectStatus(oneVersion, [200], "get one version");
    expect(
      asRecord(oneVersion.json).version === newest.version &&
        asRecord(oneVersion.json).workflowId === id,
      "get one version shape",
    );
    expectStatus(
      await ctx.api("GET", `/api/workflows/${id}/versions/9999`),
      [404],
      "get a version that does not exist",
    );
    expectStatus(
      await ctx.api("GET", `/api/workflows/${id}/versions/0`),
      [400],
      "versions start at 1",
    );
    expectStatus(
      await ctx.api("GET", `/api/workflows/${crypto.randomUUID()}/versions`),
      [404],
      "versions of an unknown workflow",
    );

    // ── trigger/validate ──────────────────────────────────────────────────────
    const valid = await ctx.api("POST", `/api/workflows/${id}/trigger/validate`, {
      body: { pr: { number: 5 } },
    });
    expectStatus(valid, [200], "validate a matching payload");
    expect(asRecord(valid.json).valid === true, "valid payload");
    const wrapped = await ctx.api("POST", `/api/workflows/${id}/trigger/validate`, {
      body: { triggerData: { pr: { number: 5 } } },
    });
    expectStatus(wrapped, [200], "validate a payload wrapped in triggerData");
    const invalidPayload = await ctx.api("POST", `/api/workflows/${id}/trigger/validate`, {
      body: { pr: { number: "five" } },
    });
    expectStatus(invalidPayload, [400], "validate a mismatching payload");
    const problem = asRecord(invalidPayload.json);
    expect(
      problem.error === "TriggerSchemaError",
      "schema failure uses the TriggerSchemaError body",
    );
    expect(
      Array.isArray(problem.details) &&
        String(problem.details[0]).includes("pr.number") &&
        String(problem.message).startsWith("Trigger schema validation failed"),
      `schema failure names the field: ${invalidPayload.text}`,
    );
    const missing = await ctx.api("POST", `/api/workflows/${id}/trigger/validate`, { body: {} });
    expectStatus(missing, [400], "validate a payload missing a required field");
    expect(
      String(asRecord(missing.json).message).includes('missing required property "pr"'),
      "missing required property is reported",
    );
    expectStatus(
      await ctx.api("POST", `/api/workflows/${crypto.randomUUID()}/trigger/validate`, { body: {} }),
      [404],
      "validate against an unknown workflow",
    );

    // ── patch (bulk) and patch node ───────────────────────────────────────────
    const patched = await ctx.api("PATCH", `/api/workflows/${id}`, {
      agentId: workerId,
      body: {
        delete: ["second"],
        update: [{ nodeId: "first", node: { next: "third", label: "renamed first" } }],
        onNodeFailure: "continue",
        triggerSchema: null,
      },
    });
    expectStatus(patched, [200], "bulk patch");
    const patchedJson = asRecord(patched.json);
    const patchedDef = asRecord(patchedJson.definition);
    expect(
      asRecords(patchedDef, "nodes")
        .map((node) => node.id)
        .join(",") === "first,third" && patchedDef.onNodeFailure === "continue",
      `bulk patch result: ${JSON.stringify(patchedDef)}`,
    );
    expect(
      asRecords(patchedDef, "nodes")[0]?.label === "renamed first" &&
        asRecords(patchedDef, "nodes")[0]?.next === "third",
      "bulk patch merged the node update",
    );
    expect(patchedJson.triggerSchema === undefined, "triggerSchema: null clears the schema");
    const created2 = await ctx.api("PATCH", `/api/workflows/${id}`, {
      body: {
        create: [bash("fourth", "four")],
        update: [{ nodeId: "third", node: { next: "fourth" } }],
        triggerSchema: { type: "object", required: ["k"] },
      },
    });
    expectStatus(created2, [200], "bulk patch creating a node");
    expect(
      asRecords(asRecord(asRecord(created2.json).definition), "nodes").length === 3 &&
        asRecord(asRecord(created2.json).triggerSchema).required !== undefined,
      "bulk patch created a node and set a schema",
    );
    const badPatches: Array<[string, Record<string, unknown>, string]> = [
      ["deleting a missing node", { delete: ["ghost"] }, "Cannot delete non-existent nodes"],
      ["creating a duplicate id", { create: [bash("first", "dup")] }, "duplicate ID"],
      [
        "updating a missing node",
        { update: [{ nodeId: "ghost", node: { label: "x" } }] },
        "Cannot update non-existent node",
      ],
      ["leaving a dangling next", { delete: ["fourth"] }, "non-existent next target"],
    ];
    for (const [label, body, needle] of badPatches) {
      const response = await ctx.api("PATCH", `/api/workflows/${id}`, { body });
      expectStatus(response, [400], `bulk patch ${label}`);
      expect(
        String(asRecord(response.json).error).includes(needle),
        `bulk patch ${label}: expected "${needle}", got ${response.text.slice(0, 300)}`,
      );
    }
    expectStatus(
      await ctx.api("PATCH", `/api/workflows/${crypto.randomUUID()}`, { body: { delete: ["x"] } }),
      [404],
      "bulk patch of an unknown workflow",
    );

    const nodePatch = await ctx.api("PATCH", `/api/workflows/${id}/nodes/fourth`, {
      agentId: workerId,
      body: {
        config: { runtime: "bash", script: `echo patched-${marker}` },
        label: "patched fourth",
      },
    });
    expectStatus(nodePatch, [200], "patch one node");
    const fourth = asRecords(asRecord(asRecord(nodePatch.json).definition), "nodes").find(
      (node) => node.id === "fourth",
    );
    expect(
      fourth?.label === "patched fourth" &&
        asRecord(fourth?.config).script === `echo patched-${marker}`,
      "node patch merged its fields",
    );
    const badNode = await ctx.api("PATCH", `/api/workflows/${id}/nodes/ghost`, {
      body: { label: "x" },
    });
    // FINDING: the route documents 404 "Workflow or node not found"; an unknown node id
    // fails the patch step ("Cannot update non-existent node") and answers 400.
    expectStatus(badNode, [400], "patch a node that does not exist");
    expect(
      String(asRecord(badNode.json).error).includes("Cannot update non-existent node"),
      "unknown node patch names the node",
    );
    expectStatus(
      await ctx.api("PATCH", `/api/workflows/${crypto.randomUUID()}/nodes/first`, {
        body: { label: "x" },
      }),
      [404],
      "node patch on an unknown workflow",
    );
    expectStatus(
      await ctx.api("PATCH", `/api/workflows/${id}/nodes/fourth`, {
        body: { type: "no-such-executor" },
      }),
      [400],
      "node patch that makes the definition invalid",
    );

    const afterPatches = await ctx.api("GET", `/api/workflows/${id}/versions`);
    expect(
      asRecords(afterPatches.json, "versions").length === before + 4,
      "PUT, two bulk patches and one node patch each wrote a version",
    );

    // ── disabled workflows do not trigger ─────────────────────────────────────
    const disable = await ctx.api("PUT", `/api/workflows/${id}`, { body: { enabled: false } });
    expectStatus(disable, [200], "disable the workflow");
    expect(asRecord(disable.json).enabled === false, "workflow is disabled");
    const refused = await ctx.api("POST", `/api/workflows/${id}/trigger`, { body: {} });
    expectStatus(refused, [400], "trigger a disabled workflow");
    expect(String(asRecord(refused.json).error).includes("disabled"), "disabled error message");
    await ctx.api("PUT", `/api/workflows/${id}`, {
      body: { enabled: true, cooldown: null, input: null },
    });
    const reread = asRecord((await ctx.api("GET", `/api/workflows/${id}`)).json);
    expect(
      reread.enabled === true && reread.cooldown === undefined && reread.input === undefined,
      "null clears cooldown and input",
    );

    // ── delete: removes the runs with it ──────────────────────────────────────
    const doomed = await createWorkflow(
      ctx,
      "wf-defs-doomed",
      { nodes: [bash("only", "x")] },
      {},
      workerId,
    );
    const doomedRun = await triggerWorkflow(ctx, doomed, {}, { agentId: workerId });
    await waitForRun(ctx, doomedRun.runId, "completed");
    const runsBefore = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_runs WHERE workflowId = ?",
      [doomed],
    );
    expect(runsBefore?.n === 1, "the doomed workflow has one run");
    const deleted = await ctx.api("DELETE", `/api/workflows/${doomed}`);
    expectStatus(deleted, [204], "delete workflow");
    expect(deleted.text === "", "delete answers with no body");
    expectStatus(await ctx.api("GET", `/api/workflows/${doomed}`), [404], "get after delete");
    expectStatus(await ctx.api("DELETE", `/api/workflows/${doomed}`), [404], "delete twice");
    const left = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_runs WHERE workflowId = ?",
      [doomed],
    );
    const leftSteps = ctx.db.get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM workflow_run_steps WHERE runId = ?",
      [doomedRun.runId],
    );
    expect(left?.n === 0 && leftSteps?.n === 0, "delete removes the runs and their steps");
    expectStatus(
      await ctx.api("GET", `/api/workflows/${doomed}/versions`),
      [404],
      "versions of a deleted workflow",
    );

    // ── MCP: the same lifecycle through the tools ─────────────────────────────
    const connection = await ctx.connectMcp(workerId);
    try {
      const mcpName = `wf-mcp-${ctx.nonce}`;
      const createBad = await callToolErr(
        connection,
        "create-workflow",
        {
          name: mcpName,
          definition: { nodes: [{ id: "a", type: "no-such-executor", config: {} }] },
        },
        "Invalid definition",
      );
      expect(
        createBad.text.includes("unregistered executor type"),
        "create-workflow names the type",
      );

      const mcpCreated = await callToolOk(connection, "create-workflow", {
        name: mcpName,
        description: "created through MCP",
        definition: { nodes: [bash("m1", "mcp-one", "m2"), bash("m2", "mcp-two")] },
        triggerSchema: { type: "object", required: ["who"] },
        cooldown: { seconds: 1 },
      });
      const mcpWorkflow = asRecord(mcpCreated.structured.workflow);
      const mcpId = asString(mcpWorkflow.id, "mcp workflow id");
      created.push(mcpId);
      expect(
        mcpCreated.text.includes(`Created workflow "${mcpName}"`) &&
          mcpWorkflow.createdByAgentId === workerId,
        "create-workflow reports the workflow",
      );
      expect(
        ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workflows WHERE id = ?", [mcpId])
          ?.n === 1,
        "create-workflow persisted the row",
      );

      const mcpGot = await callToolOk(connection, "get-workflow", { id: mcpId });
      expect(
        asRecord(mcpGot.structured.workflow).name === mcpName &&
          asRecords(mcpGot.structured, "edges").length === 1,
        "get-workflow returns the workflow and its edges",
      );
      expect(mcpGot.text.includes('"m1"'), "get-workflow puts the definition on the text channel");
      await callToolErr(connection, "get-workflow", { id: crypto.randomUUID() }, "not found");

      const slimList = await callToolOk(connection, "list-workflows", { keyPrefix: "shared/" });
      const listed = asRecords(slimList.structured, "workflows");
      const mine = listed.find((entry) => entry.id === mcpId);
      expect(mine && mine.nodeCount === 2 && !("definition" in mine), "list-workflows is slim");
      const fullList = await callToolOk(connection, "list-workflows", {
        enabled: true,
        includeFull: true,
        key: String(mcpWorkflow.key),
      });
      const fullListed = asRecords(fullList.structured, "workflows");
      expect(
        fullListed.length === 1 && "definition" in (fullListed[0] ?? {}),
        "list-workflows includeFull with an exact key",
      );
      const disabledList = await callToolOk(connection, "list-workflows", {
        enabled: false,
        key: String(mcpWorkflow.key),
      });
      expect(asRecords(disabledList.structured, "workflows").length === 0, "enabled=false filter");

      const mcpUpdated = await callToolOk(connection, "update-workflow", {
        id: mcpId,
        description: "updated through MCP",
        definition: {
          nodes: [bash("m1", "mcp-uno", "m2"), bash("m2", "mcp-dos", "m3"), bash("m3", "mcp-tres")],
        },
        cooldown: null,
        triggerSchema: null,
      });
      expect(
        typeof mcpUpdated.structured.versionCreated === "number" &&
          asRecord(mcpUpdated.structured.workflow).description === "updated through MCP",
        "update-workflow reports the new version",
      );
      expect(
        asRecord(mcpUpdated.structured.workflow).triggerSchema === undefined,
        "update-workflow null clears the trigger schema",
      );
      await callToolErr(
        connection,
        "update-workflow",
        { id: crypto.randomUUID(), name: "x" },
        "not found",
      );
      await callToolErr(
        connection,
        "update-workflow",
        { id: mcpId, definition: { nodes: [{ ...bash("a", "x"), next: "ghost" }] } },
        "Invalid definition",
      );

      const mcpPatched = await callToolOk(connection, "patch-workflow", {
        id: mcpId,
        delete: ["m3"],
        update: [{ nodeId: "m2", node: { label: "second", next: "m4" } }],
        create: [{ id: "m4", type: "script", config: { runtime: "bash", script: "echo m4" } }],
        triggerSchema: { type: "object", required: ["who"] },
      });
      const patchedNodes = asRecords(
        asRecord(asRecord(mcpPatched.structured.workflow).definition),
        "nodes",
      );
      expect(
        patchedNodes
          .map((node) => node.id)
          .sort()
          .join(",") === "m1,m2,m4",
        `patch-workflow result nodes: ${patchedNodes.map((node) => node.id)}`,
      );
      await callToolErr(connection, "patch-workflow", { id: mcpId, delete: ["ghost"] }, "ghost");
      await callToolErr(
        connection,
        "patch-workflow",
        { id: crypto.randomUUID(), delete: ["m1"] },
        "not found",
      );

      const nodeResult = await callToolOk(connection, "patch-workflow-node", {
        id: mcpId,
        nodeId: "m1",
        config: { runtime: "bash", script: "echo patched-m1" },
      });
      expect(
        typeof nodeResult.structured.versionCreated === "number" &&
          nodeResult.text.includes('Patched node "m1"'),
        "patch-workflow-node reports the version",
      );
      await callToolErr(
        connection,
        "patch-workflow-node",
        { id: mcpId, nodeId: "ghost", label: "x" },
        "Patch errors",
      );
      await callToolErr(
        connection,
        "patch-workflow-node",
        { id: crypto.randomUUID(), nodeId: "m1", label: "x" },
        "not found",
      );

      const mcpVersions = ctx.db.get<{ n: number }>(
        "SELECT COUNT(*) AS n FROM workflow_versions WHERE workflowId = ?",
        [mcpId],
      );
      expect(mcpVersions?.n === 3, `three tool edits wrote three versions, got ${mcpVersions?.n}`);

      const mcpDeleted = await callToolOk(connection, "delete-workflow", { id: mcpId });
      expect(mcpDeleted.text.includes(mcpId), "delete-workflow names the workflow");
      created.pop();
      await callToolErr(connection, "delete-workflow", { id: mcpId }, "not found");
      expectStatus(await ctx.api("GET", `/api/workflows/${mcpId}`), [404], "tool-deleted workflow");
    } finally {
      await connection.close();
    }

    for (const workflowId of created) {
      expectStatus(await ctx.api("DELETE", `/api/workflows/${workflowId}`), [204], "cleanup");
    }
  },
};
