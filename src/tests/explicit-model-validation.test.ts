// An explicit model id (task, schedule, workflow node, agent runtime) is checked against the
// model catalog; `allowCustomModel` is the escape hatch. See src/be/model-validation.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import {
  closeDb,
  createAgent,
  createScriptRun,
  createTaskExtended,
  getDbClient,
  getSwarmConfigs,
  initDb,
} from "../be/db";
import { reloadModelsCatalog } from "../be/model-catalog-store";
import { validateTierConfigValue } from "../be/model-tier-keys";
import {
  explicitModelError,
  explicitModelErrorForAgent,
  isKnownCatalogModel,
} from "../be/model-validation";
import { handleAgentsRest } from "../http/agents";
import { handleSchedules } from "../http/schedules";
import { handleScriptRuns } from "../http/script-runs";
import { handleTasks } from "../http/tasks";
import { sendTaskHandler } from "../tools/send-task";
import { taskActionHandler } from "../tools/task-action";
import { ownerCtx } from "../tools/task-tool-ctx";
import type { WorkflowDefinition } from "../types";
import { setRequestAuth } from "../utils/request-auth-context";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
import { workflowModelErrors } from "../workflows/model-validation";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-explicit-model-validation.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    await unlink(path + suffix).catch(() => undefined);
  }
}

let server: Server;
let baseUrl = "";
let leadId = "";
let workerId = "";
let acpId = "";
let codexId = "";

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  // Drop any catalog projection an earlier file cached in this process.
  await reloadModelsCatalog();
  leadId = (await createAgent({ name: "validation-lead", isLead: true, status: "idle" })).id;
  workerId = (
    await createAgent({
      name: "validation-worker",
      isLead: false,
      status: "idle",
      harnessProvider: "claude",
    })
  ).id;
  acpId = (
    await createAgent({
      name: "validation-acp",
      isLead: false,
      status: "idle",
      harnessProvider: "acp",
    })
  ).id;
  codexId = (
    await createAgent({
      name: "validation-codex",
      isLead: false,
      status: "idle",
      harnessProvider: "codex",
    })
  ).id;

  server = createServer((req, res) => {
    setRequestAuth(req, { kind: "operator", fingerprint: "explicit-model-validation-test" });
    const url = new URL(req.url ?? "/", "http://localhost");
    const segments = url.pathname.split("/").filter(Boolean);
    const agentId = (req.headers["x-agent-id"] as string | undefined) ?? undefined;
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      if (await handleTasks(req, res, segments, url.searchParams, agentId)) return;
      if (await handleSchedules(req, res, segments, url.searchParams, agentId)) return;
      if (await handleAgentsRest(req, res, segments, url.searchParams, agentId)) return;
      if (await handleScriptRuns(req, res, segments, url.searchParams, agentId)) return;
      res.writeHead(404);
      res.end("{}");
    })();
  });
  baseUrl = `http://localhost:${await listenOnFreePort(server)}`;
});

afterAll(async () => {
  server.close();
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

async function api(method: string, path: string, body: unknown) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, any>) : {} };
}

/** Run `fn` with every registered agent on the codex harness, then restore the rows. */
async function withOnlyCodexAgents(fn: () => Promise<void>): Promise<void> {
  const db = getDbClient();
  const saved = await db.query<{ id: string; harness_provider: string | null }>(
    "SELECT id, harness_provider FROM agents",
  );
  try {
    await db.run("UPDATE agents SET harness_provider = 'codex'");
    await fn();
  } finally {
    for (const row of saved) {
      await db.run("UPDATE agents SET harness_provider = ? WHERE id = ?", [
        row.harness_provider,
        row.id,
      ]);
    }
  }
}

describe("isKnownCatalogModel", () => {
  const catalog = {
    anthropic: {
      models: {
        "claude-opus-5-5": { release_date: "2026-09-22" },
        "claude-sonnet-5-5": { release_date: "2026-09-28" },
      },
    },
    openai: { models: { "gpt-5.6-sol": {} } },
    openrouter: { models: { "deepseek/deepseek-v4.1-flash": {} } },
    "amazon-bedrock": { models: { "anthropic.claude-sonnet-5": {} } },
  };

  test("catalog ids, bare or provider-qualified, and Claude CLI shortnames are known", () => {
    for (const id of [
      "claude-opus-5-5",
      "gpt-5.6-sol",
      "anthropic/claude-opus-5-5",
      "openrouter/deepseek/deepseek-v4.1-flash",
      "deepseek/deepseek-v4.1-flash",
      "amazon-bedrock/anthropic.claude-sonnet-5",
      "amazon-bedrock/us.anthropic.claude-sonnet-5",
      "opus",
      "sonnet",
      "claude-opus-5-5[1m]",
    ]) {
      expect(isKnownCatalogModel(id, catalog)).toBe(true);
    }
  });

  test("a typo, a wrong provider, and object-prototype names are unknown", () => {
    for (const id of [
      "claude-nonexistent-9",
      "claude-opus-5-6",
      "openrouter/deepseek/nope",
      "gpt-9",
      "haikuu",
      "constructor",
      "__proto__",
      "toString",
      "openai/constructor",
      "",
    ]) {
      expect(isKnownCatalogModel(id, catalog)).toBe(false);
    }
  });
});

describe("explicitModelError", () => {
  test("rejects an unknown id with a message that names the escape hatch", async () => {
    const error = await explicitModelError({ model: "claude-nonexistent-9" });
    expect(error).toContain('Unknown model "claude-nonexistent-9"');
    expect(error).toContain("allowCustomModel");
  });

  test("passes a catalog id, a shortname, nothing at all, and a custom id with the flag", async () => {
    expect(await explicitModelError({ model: "claude-opus-5-5" })).toBeNull();
    expect(await explicitModelError({ model: "opus" })).toBeNull();
    expect(await explicitModelError({ model: undefined })).toBeNull();
    expect(await explicitModelError({ model: "  " })).toBeNull();
    expect(
      await explicitModelError({ model: "claude-nonexistent-9", allowCustomModel: true }),
    ).toBeNull();
  });

  test("aliases: valid grammar that resolves passes, bad grammar and empty matches fail", async () => {
    expect(await explicitModelError({ model: "latest:anthropic/opus" })).toBeNull();
    expect(await explicitModelError({ model: "latest:nonsense" })).toContain("Invalid model alias");
    expect(await explicitModelError({ model: "latest:anthropic/nosuchfamily" })).toContain(
      "matches no model",
    );
  });

  test("harnesses the catalog does not describe skip the check", async () => {
    for (const harnessProvider of ["acp", "devin", "dsh"]) {
      expect(await explicitModelError({ model: "vendor-private-1", harnessProvider })).toBeNull();
    }
    expect(
      await explicitModelError({ model: "vendor-private-1", harnessProvider: "claude" }),
    ).toContain("Unknown model");
  });

  test("an Anthropic model on codex fails even with allowCustomModel", async () => {
    for (const allowCustomModel of [false, true]) {
      const error = await explicitModelError({
        model: "claude-opus-5-5",
        harnessProvider: "codex",
        allowCustomModel,
      });
      expect(error).toContain("does not run on the codex harness");
      expect(error).toContain("gpt-");
    }
  });

  test("an OpenAI model on claude fails", async () => {
    expect(await explicitModelError({ model: "gpt-5.6-sol", harnessProvider: "claude" })).toContain(
      "does not run on the claude harness",
    );
  });

  test("the directed message names the agent", async () => {
    const error = await explicitModelErrorForAgent({ model: "claude-opus-5-5", agentId: codexId });
    expect(error).toContain(`of agent "validation-codex" (${codexId})`);
  });

  test("pool existence: passes with a Claude agent registered, fails with only Codex agents", async () => {
    expect(await explicitModelErrorForAgent({ model: "claude-opus-5-5" })).toBeNull();
    await withOnlyCodexAgents(async () => {
      const error = await explicitModelErrorForAgent({ model: "claude-opus-5-5" });
      expect(error).toContain(
        'Model "claude-opus-5-5" does not run on any registered agent harness (codex)',
      );
      expect(await explicitModelErrorForAgent({ model: "gpt-5.6-sol" })).toBeNull();
      expect(await explicitModelErrorForAgent({ model: "latest:anthropic/opus" })).toBeNull();
    });
  });
});

describe("MODEL_TIER_<PROVIDER>_<TIER> values", () => {
  test("a model from another harness family is rejected on write", () => {
    expect(validateTierConfigValue("MODEL_TIER_CODEX_SMART", "claude-opus-5-5")).toBe(
      'Invalid MODEL_TIER_CODEX_SMART: model "claude-opus-5-5" does not run on the codex harness.',
    );
    expect(validateTierConfigValue("MODEL_TIER_CLAUDE_MANAGED_SMART", "gpt-5.6-sol")).toContain(
      "does not run on the claude-managed harness",
    );
  });

  test("own-harness values, shortnames and unpinned providers pass", () => {
    expect(validateTierConfigValue("MODEL_TIER_CODEX_SMART", "gpt-5.6-sol")).toBeNull();
    expect(validateTierConfigValue("MODEL_TIER_CLAUDE_SMART", "opus")).toBeNull();
    expect(validateTierConfigValue("MODEL_TIER_PI_SMART", "claude-opus-5-5")).toBeNull();
  });
});

describe("POST /api/tasks", () => {
  const base = { task: "validate the model", agentId: leadId, routingReason: "skill" };

  test("an unknown model is a 400 and creates no task", async () => {
    const before = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks");
    const res = await api("POST", "/api/tasks", { ...base, model: "claude-nonexistent-9" });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("Unknown model");
    const after = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks");
    expect(after?.n).toBe(before?.n ?? 0);
  });

  test("a catalog model, an alias, a tier and a custom id with the flag are accepted", async () => {
    for (const extra of [
      { model: "claude-opus-5-5" },
      { model: "latest:anthropic/opus" },
      { modelTier: "smart" },
      { model: "claude-nonexistent-9", allowCustomModel: true },
    ]) {
      const res = await api("POST", "/api/tasks", { ...base, ...extra });
      expect(res.status).toBe(201);
    }
  });

  test("an ACP assignee takes any model id", async () => {
    const res = await api("POST", "/api/tasks", {
      ...base,
      agentId: acpId,
      model: "acp-private-model",
    });
    expect(res.status).toBe(201);
  });
});

describe("send-task", () => {
  const args = { task: "validate the model", offerMode: false, allowDuplicate: false };

  test("an unknown model is refused, the flag lets it through", async () => {
    const sender = ownerCtx({ agentId: workerId });
    const refused = await sendTaskHandler(sender, { ...args, model: "claude-nonexistent-9" });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("Unknown model");
    const accepted = await sendTaskHandler(sender, {
      ...args,
      model: "claude-nonexistent-9",
      allowCustomModel: true,
    });
    expect(accepted.ok).toBe(true);
  });
});

describe("schedules", () => {
  const body = { name: "s-unknown-model", taskTemplate: "tick", intervalMs: 3_600_000 };

  test("create rejects an unknown model; the flag stores it", async () => {
    const refused = await api("POST", "/api/schedules", { ...body, model: "claude-nonexistent-9" });
    expect(refused.status).toBe(400);
    const accepted = await api("POST", "/api/schedules", {
      ...body,
      name: "s-custom-model",
      model: "claude-nonexistent-9",
      allowCustomModel: true,
    });
    expect(accepted.status).toBe(201);
    expect(accepted.body.model).toBe("claude-nonexistent-9");
  });

  test("update rejects a new unknown model but re-saves the stored one", async () => {
    const created = await api("POST", "/api/schedules", {
      ...body,
      name: "s-update-model",
      model: "claude-nonexistent-9",
      allowCustomModel: true,
    });
    const id = created.body.id as string;
    const changed = await api("PUT", `/api/schedules/${id}`, { model: "claude-nonexistent-10" });
    expect(changed.status).toBe(400);
    const resaved = await api("PUT", `/api/schedules/${id}`, {
      model: "claude-nonexistent-9",
      description: "an unrelated edit",
    });
    expect(resaved.status).toBe(200);
    expect(resaved.body.description).toBe("an unrelated edit");
  });

  test("update to a new unknown model with the flag succeeds on PUT and PATCH", async () => {
    const created = await api("POST", "/api/schedules", {
      ...body,
      name: "s-update-custom-model",
      model: "claude-sonnet-5-5",
    });
    const id = created.body.id as string;
    const put = await api("PUT", `/api/schedules/${id}`, {
      model: "claude-nonexistent-10",
      allowCustomModel: true,
    });
    expect(put.status).toBe(200);
    expect(put.body.model).toBe("claude-nonexistent-10");
    expect(put.body.allowCustomModel).toBeUndefined();
    const patch = await api("PATCH", `/api/schedules/${id}`, {
      model: "claude-nonexistent-11",
      allowCustomModel: true,
    });
    expect(patch.status).toBe(200);
    expect(patch.body.model).toBe("claude-nonexistent-11");
  });
});

describe("PATCH /api/agents/:id/runtime", () => {
  test("an unknown model is a 400 and writes nothing; allow_custom_model stores it", async () => {
    const path = `/api/agents/${workerId}/runtime`;
    const refused = await api("PATCH", path, {
      harness_provider: "claude",
      model: "claude-nonexistent-9",
    });
    expect(refused.status).toBe(400);
    const rows = await getSwarmConfigs({ scope: "agent", scopeId: workerId });
    expect(rows.find((r) => r.key === "MODEL_OVERRIDE")).toBeUndefined();

    const accepted = await api("PATCH", path, {
      harness_provider: "claude",
      model: "claude-nonexistent-9",
      allow_custom_model: true,
    });
    expect(accepted.status).toBe(200);
  });

  test("a latest: alias is not an agent default model", async () => {
    const res = await api("PATCH", `/api/agents/${workerId}/runtime`, {
      harness_provider: "claude",
      model: "latest:anthropic/opus",
      allow_custom_model: true,
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("MODEL_TIER");
  });
});

describe("workflow agent-task node", () => {
  test("fails the node on an unknown model, accepts it with allowCustomModel", async () => {
    const deps = {
      db: {
        getTaskByWorkflowRunStepId: async () => null,
        getWorkflow: async () => null,
        createTaskExtended: async () => ({ id: crypto.randomUUID() }),
      },
    } as unknown as ConstructorParameters<typeof AgentTaskExecutor>[0];
    const executor = new AgentTaskExecutor(deps);
    const meta = { runId: crypto.randomUUID(), stepId: crypto.randomUUID(), nodeId: "n" } as never;
    const refused = await executor.run({
      config: { template: "do it", model: "claude-nonexistent-9" },
      context: {},
      meta,
    });
    expect(refused.status).toBe("failed");
    expect(refused.error).toContain("Unknown model");
    const accepted = await executor.run({
      config: { template: "do it", model: "claude-nonexistent-9", allowCustomModel: true },
      context: {},
      meta,
    });
    expect(accepted.status).toBe("success");
  });
});

describe("harness compatibility at every create entry point", () => {
  test("POST /api/tasks: an Anthropic model on a Codex agent is a 400; modelTier is a 201", async () => {
    const before = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks");
    const base = { task: "harness guard", agentId: codexId, routingReason: "human_pinned" };
    const refused = await api("POST", "/api/tasks", { ...base, model: "claude-opus-5-5" });
    expect(refused.status).toBe(400);
    expect(String(refused.body.error)).toContain("does not run on the codex harness");
    const after = await getDbClient().get<{ n: number }>("SELECT COUNT(*) AS n FROM agent_tasks");
    expect(after?.n).toBe(before?.n ?? 0);
    const accepted = await api("POST", "/api/tasks", { ...base, modelTier: "smart" });
    expect(accepted.status).toBe(201);
  });

  test("POST /api/tasks: an uncatalogued id in the harness's own namespace follows allowCustomModel", async () => {
    const base = { task: "qualified custom", agentId: codexId, routingReason: "human_pinned" };
    const custom = { ...base, model: "openai/private-deployment-1" };
    const withFlag = await api("POST", "/api/tasks", { ...custom, allowCustomModel: true });
    expect(withFlag.status).toBe(201);
    const withoutFlag = await api("POST", "/api/tasks", custom);
    expect(withoutFlag.status).toBe(400);
    expect(String(withoutFlag.body.error)).toContain("allowCustomModel");
    for (const model of ["anthropic/private-deployment-1", "openai/gpt-4o"]) {
      const refused = await api("POST", "/api/tasks", { ...base, model, allowCustomModel: true });
      expect(refused.status).toBe(400);
      expect(String(refused.body.error)).toContain("does not run on the codex harness");
    }
  });

  test("send-task: the parent auto-route target is judged", async () => {
    const parent = await createTaskExtended("codex parent", { agentId: codexId, source: "mcp" });
    const refused = await sendTaskHandler(ownerCtx({ agentId: workerId }), {
      task: "child of a codex task",
      parentTaskId: parent.id,
      model: "claude-opus-5-5",
      offerMode: false,
      allowDuplicate: false,
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain("does not run on the codex harness");
  });

  test("task-action create: a pool model no registered harness runs is refused", async () => {
    await withOnlyCodexAgents(async () => {
      const refused = await taskActionHandler(ownerCtx({ agentId: workerId }), {
        action: "create",
        task: "pool task for nobody",
        model: "claude-opus-5-5",
      } as Parameters<typeof taskActionHandler>[1]);
      expect(refused.ok).toBe(false);
      expect(refused.message).toContain("does not run on any registered agent harness (codex)");
    });
  });

  test("internal script-run agent-task route: a cross-harness model is a 400", async () => {
    const runId = crypto.randomUUID();
    await createScriptRun({ id: runId, agentId: workerId, source: "inline", args: {} });
    const res = await api("POST", `/api/internal/script-runs/${runId}/agent-task`, {
      stepKey: "step-1",
      task: "script step",
      agentId: codexId,
      model: "claude-opus-5-5",
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("does not run on the codex harness");
  });

  test("create-schedule: a Codex target with an Anthropic model is refused", async () => {
    const res = await api("POST", "/api/schedules", {
      name: "s-harness-create",
      taskTemplate: "tick",
      intervalMs: 3_600_000,
      targetAgentId: codexId,
      model: "claude-opus-5-5",
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("does not run on the codex harness");
  });

  test("update-schedule: moving the target from a Claude agent to a Codex agent is refused", async () => {
    const created = await api("POST", "/api/schedules", {
      name: "s-harness-move",
      taskTemplate: "tick",
      intervalMs: 3_600_000,
      targetAgentId: workerId,
      model: "claude-opus-5-5",
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    for (const method of ["PUT", "PATCH"]) {
      const moved = await api(method, `/api/schedules/${id}`, { targetAgentId: codexId });
      expect(moved.status).toBe(400);
      expect(String(moved.body.error)).toContain("does not run on the codex harness");
    }
    const unrelated = await api("PUT", `/api/schedules/${id}`, { description: "still claude" });
    expect(unrelated.status).toBe(200);
  });

  test("workflow save: an agent-task node pinned to a Codex agent with an Anthropic model fails", async () => {
    const definition = {
      nodes: [
        {
          id: "review",
          type: "agent-task",
          config: { template: "review it", agentId: codexId, model: "claude-opus-5-5" },
        },
      ],
    } as unknown as WorkflowDefinition;
    const errors = await workflowModelErrors(definition);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('Node "review" config.model');
    expect(errors[0]).toContain("does not run on the codex harness");
    const tier = {
      nodes: [
        {
          id: "review",
          type: "agent-task",
          config: { template: "review it", agentId: codexId, modelTier: "smart" },
        },
      ],
    } as unknown as WorkflowDefinition;
    expect(await workflowModelErrors(tier)).toEqual([]);
  });

  test("workflow executor: a Codex node with an Anthropic model fails at run time", async () => {
    const deps = {
      db: {
        getTaskByWorkflowRunStepId: async () => null,
        getWorkflow: async () => null,
        createTaskExtended: async () => ({ id: crypto.randomUUID() }),
      },
    } as unknown as ConstructorParameters<typeof AgentTaskExecutor>[0];
    const result = await new AgentTaskExecutor(deps).run({
      config: { template: "do it", agentId: codexId, model: "claude-opus-5-5" },
      context: {},
      meta: { runId: crypto.randomUUID(), stepId: crypto.randomUUID(), nodeId: "n" } as never,
    });
    expect(result.status).toBe("failed");
    expect(result.error).toContain("does not run on the codex harness");
  });

  test("PATCH /api/agents/:id/runtime: an Anthropic model for a codex harness is a 400", async () => {
    const res = await api("PATCH", `/api/agents/${codexId}/runtime`, {
      harness_provider: "codex",
      model: "claude-opus-5-5",
    });
    expect(res.status).toBe(400);
    expect(String(res.body.error)).toContain("does not run on the codex harness");
  });
});
