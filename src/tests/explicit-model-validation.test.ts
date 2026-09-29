// An explicit model id (task, schedule, workflow node, agent runtime) is checked against the
// model catalog; `allowCustomModel` is the escape hatch. See src/be/model-validation.ts.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { closeDb, createAgent, getDbClient, getSwarmConfigs, initDb } from "../be/db";
import { explicitModelError, isKnownCatalogModel } from "../be/model-validation";
import { handleAgentsRest } from "../http/agents";
import { handleSchedules } from "../http/schedules";
import { handleTasks } from "../http/tasks";
import { sendTaskHandler } from "../tools/send-task";
import { ownerCtx } from "../tools/task-tool-ctx";
import { setRequestAuth } from "../utils/request-auth-context";
import { AgentTaskExecutor } from "../workflows/executors/agent-task";
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

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
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
