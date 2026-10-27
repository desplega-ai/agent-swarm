// Request composition manifest: the worker posts prompt part sizes, the server
// adds the swarm tool-schema estimate and serves the manifests per task.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { closeDb, createAgent, createTaskExtended, initDb, upsertKv } from "../be/db";
import {
  createRequestComposition,
  getTokenRatio,
  MAX_REQUEST_COMPOSITIONS_PER_TASK,
  nextTokenRatio,
  recordTokenRatio,
  TOKEN_RATIO_KV_NAMESPACE,
  tokenRatioKey,
} from "../be/db/request-composition";
import { postRequestComposition, requestToolLoading } from "../commands/runner";
import { handleCore } from "../http/core";
import { handleRequestComposition } from "../http/request-composition";
import {
  type ListedTool,
  listSessionToolsMemo,
  measureToolSchemas,
  resetToolSchemaMemo,
} from "../http/tool-schema-estimate";
import { getPathSegments, parseQueryParams } from "../http/utils";
import type { RequestComposition } from "../types";
import { listenOnFreePort } from "./test-net";

const TEST_DB_PATH = "./test-request-composition.sqlite";
const API_KEY = "test-request-composition";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

let server: Server;
let port: number;
let agentId: string;
let taskId: string;
const savedEnv = {
  SWARM_ENABLED_TOOLS: process.env.SWARM_ENABLED_TOOLS,
  SCRIPTS_ONLY_MCP: process.env.SCRIPTS_ONLY_MCP,
  TASK_TOOL_MANIFESTS: process.env.TASK_TOOL_MANIFESTS,
};

beforeAll(async () => {
  for (const key of Object.keys(savedEnv)) delete process.env[key];
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  agentId = (await createAgent({ name: "composition-test", isLead: false, status: "idle" })).id;
  taskId = (await createTaskExtended("composition fixture", { agentId, source: "mcp" })).id;
  server = createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    const myAgentId = req.headers["x-agent-id"] as string | undefined;
    if (await handleCore(req, res, myAgentId, API_KEY)) return;
    const url = req.url || "";
    if (
      !(await handleRequestComposition(
        req,
        res,
        getPathSegments(url),
        parseQueryParams(url),
        myAgentId,
      ))
    ) {
      res.writeHead(404).end();
    }
  });
  port = await listenOnFreePort(server);
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

const headers = (withAgent = true): Record<string, string> => ({
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
  ...(withAgent ? { "X-Agent-ID": agentId } : {}),
});

function post(body: Record<string, unknown>, id = taskId, withAgent = true) {
  return fetch(`http://localhost:${port}/api/tasks/${id}/request-composition`, {
    method: "POST",
    headers: headers(withAgent),
    body: JSON.stringify(body),
  });
}

async function manifests(id = taskId, query = ""): Promise<RequestComposition[]> {
  const res = await fetch(`http://localhost:${port}/api/tasks/${id}/request-composition${query}`, {
    headers: headers(),
  });
  expect(res.status).toBe(200);
  return ((await res.json()) as { manifests: RequestComposition[] }).manifests;
}

const workerParts = [
  { kind: "persona", id: "persona", label: "persona", chars: 400 },
  { kind: "system_section", id: "system.agent.role", label: "system.agent.role", chars: 101 },
  { kind: "task_prompt", id: "task_prompt", label: "task prompt", chars: 2000 },
];

describe("POST/GET /api/tasks/{id}/request-composition", () => {
  test("round trip: estimates tokens, adds tool schemas, bumps seq per session", async () => {
    const first = await post({
      sessionId: "sess-1",
      provider: "codex",
      model: "gpt-5",
      toolLoading: "all",
      parts: workerParts,
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ ok: true, seq: 0 });

    const second = await post({
      sessionId: "sess-1",
      provider: "codex",
      toolLoading: "none",
      parts: workerParts,
    });
    expect(await second.json()).toMatchObject({ ok: true, seq: 1 });

    const [m0, m1] = await manifests();
    expect(m0).toMatchObject({ taskId, agentId, sessionId: "sess-1", seq: 0, provider: "codex" });
    expect(m0!.model).toBe("gpt-5");
    expect(m0!.source).toBe("worker");
    expect(m0!.tokenRatio).toBe(1);
    expect(m0!.parts.find((part) => part.id === "system.agent.role")).toMatchObject({
      chars: 101,
      estTokens: 26,
      fidelity: "exact",
    });

    const tools = m0!.parts.find((part) => part.kind === "tool_schemas");
    expect(tools?.fidelity).toBe("estimate");
    expect(tools!.estTokens).toBeGreaterThan(0);
    expect(m0!.staticEstTokens).toBe(m0!.parts.reduce((sum, part) => sum + part.estTokens, 0));

    // toolLoading "none": no tool part (devin and other MCP-less harnesses).
    expect(m1!.parts.some((part) => part.kind === "tool_schemas")).toBe(false);
  });

  test("deferral shrinks the tool estimate: all > core > preloaded", async () => {
    const sizes: Record<string, number> = {};
    for (const toolLoading of ["all", "core", "preloaded"] as const) {
      await post({ sessionId: `sess-${toolLoading}`, provider: "x", toolLoading, parts: [] });
    }
    for (const manifest of await manifests()) {
      const part = manifest.parts.find((p) => p.kind === "tool_schemas");
      if (part) sizes[manifest.sessionId] = part.estTokens;
    }
    expect(sizes["sess-all"]!).toBeGreaterThan(sizes["sess-core"]!);
    expect(sizes["sess-core"]!).toBeGreaterThan(sizes["sess-preloaded"]!);
    expect(sizes["sess-preloaded"]!).toBeGreaterThan(0);
  });

  test("SWARM_ENABLED_TOOLS narrows the measured surface", async () => {
    resetToolSchemaMemo();
    process.env.SWARM_ENABLED_TOOLS = "store-progress,get-tasks";
    try {
      await post({ sessionId: "sess-allowlist", provider: "codex", toolLoading: "all", parts: [] });
    } finally {
      delete process.env.SWARM_ENABLED_TOOLS;
      resetToolSchemaMemo();
    }
    const all = (await manifests()).find((m) => m.sessionId === "sess-all");
    const narrowed = (await manifests()).find((m) => m.sessionId === "sess-allowlist");
    const size = (m?: RequestComposition) =>
      m?.parts.find((p) => p.kind === "tool_schemas")?.estTokens ?? 0;
    expect(size(narrowed)).toBeGreaterThan(0);
    expect(size(narrowed)).toBeLessThan(size(all) / 10);
  });

  test("rejects a missing agent header, a bad body and an unknown task", async () => {
    const body = { sessionId: "s", provider: "codex", toolLoading: "all", parts: [] };
    expect((await post(body, taskId, false)).status).toBe(400);
    expect((await post({ ...body, toolLoading: "sometimes" })).status).toBe(400);
    expect(
      (await post({ ...body, parts: [{ kind: "nope", id: "x", label: "x", chars: 1 }] })).status,
    ).toBe(400);
    expect((await post(body, crypto.randomUUID())).status).toBe(404);
  });

  test("rejects a post for a task assigned to another agent", async () => {
    const other = await createAgent({ name: "composition-other", isLead: false, status: "idle" });
    const foreign = await createTaskExtended("foreign", { agentId: other.id, source: "mcp" });
    const body = { sessionId: "s-foreign", provider: "codex", toolLoading: "none", parts: [] };
    expect((await post(body, foreign.id)).status).toBe(403);
    expect(await manifests(foreign.id)).toEqual([]);
  });

  test("caps manifests per task and bounds the GET", async () => {
    const capped = await createTaskExtended("capped", { agentId, source: "mcp" });
    for (let i = 0; i < MAX_REQUEST_COMPOSITIONS_PER_TASK; i++) {
      const stored = await createRequestComposition({
        taskId: capped.id,
        agentId,
        sessionId: `s-cap-${i}`,
        provider: "codex",
        source: "worker",
        parts: [],
      });
      expect(stored).not.toBeNull();
    }
    const body = { sessionId: "s-cap-over", provider: "codex", toolLoading: "none", parts: [] };
    expect((await post(body, capped.id)).status).toBe(429);
    expect(await manifests(capped.id)).toHaveLength(MAX_REQUEST_COMPOSITIONS_PER_TASK);

    const firstTwo = await manifests(capped.id, "?limit=2");
    expect(firstTwo.map((m) => m.sessionId)).toEqual(["s-cap-0", "s-cap-1"]);
    const tooMany = await fetch(
      `http://localhost:${port}/api/tasks/${capped.id}/request-composition?limit=${MAX_REQUEST_COMPOSITIONS_PER_TASK + 1}`,
      { headers: headers() },
    );
    expect(tooMany.status).toBe(400);
  });
});

describe("tool schema measurement", () => {
  const tools: ListedTool[] = [
    { name: "store-progress", description: "core", inputSchema: { type: "object" } },
    { name: "create-workflow", description: "big", inputSchema: { type: "object", a: 1 } },
    {
      name: "list-repos",
      description: "pinned",
      inputSchema: { type: "object" },
      _meta: { "anthropic/alwaysLoad": true },
    },
  ];
  const schema = (tool: ListedTool) =>
    JSON.stringify({
      name: tool.name,
      description: tool.description,
      input_schema: tool.inputSchema,
    }).length;

  test("each loading mode counts loaded schemas plus deferred names", () => {
    const [core, big, pinned] = tools as [ListedTool, ListedTool, ListedTool];
    expect(measureToolSchemas(tools, "all").chars).toBe(
      schema(core) + schema(big) + schema(pinned),
    );
    expect(measureToolSchemas(tools, "core")).toEqual({
      chars: schema(core) + schema(pinned) + big.name.length + 1,
      loadedCount: 2,
      deferredCount: 1,
    });
    expect(measureToolSchemas(tools, "preloaded")).toEqual({
      chars: schema(pinned) + core.name.length + 1 + big.name.length + 1,
      loadedCount: 1,
      deferredCount: 2,
    });
    expect(measureToolSchemas(tools, "none").chars).toBe(0);
  });

  test("full surface is far larger than the core set", async () => {
    resetToolSchemaMemo();
    const listed = await listSessionToolsMemo({
      preloadedTools: [],
      excludedTools: [],
      enabledTools: undefined,
      scriptsOnly: false,
    });
    const full = measureToolSchemas(listed, "all").chars;
    const core = measureToolSchemas(listed, "core").chars;
    expect(full).toBeGreaterThan(0);
    expect(core).toBeLessThan(full);
  });
});

describe("worker side", () => {
  test("tool loading follows the harness's deferral", () => {
    expect(requestToolLoading("claude", { hasMcp: true, hasToolSearch: true })).toBe("preloaded");
    expect(requestToolLoading("pi", { hasMcp: true, hasToolSearch: true })).toBe("core");
    expect(requestToolLoading("pi", { hasMcp: true, hasToolSearch: false })).toBe("all");
    expect(requestToolLoading("codex", { hasMcp: true })).toBe("all");
    expect(requestToolLoading("devin", { hasMcp: false })).toBe("none");
  });

  test("a failed post never throws into the session", async () => {
    const body = { sessionId: "s", provider: "codex", toolLoading: "all" as const, parts: [] };
    // Unreachable API: the fetch rejects inside the helper.
    expect(() =>
      postRequestComposition("http://127.0.0.1:1", API_KEY, agentId, taskId, body),
    ).not.toThrow();
    // Reachable API answering 404 for an unknown task.
    expect(() =>
      postRequestComposition(`http://localhost:${port}`, API_KEY, agentId, "missing", body),
    ).not.toThrow();
    await Bun.sleep(50);
  });
});

describe("harness-hook manifests and token ratio calibration", () => {
  const hookBody = (sessionId: string, provider: string, promptTokens: number) => ({
    sessionId,
    provider,
    model: "m",
    source: "harness-hook",
    toolLoading: "none",
    parts: [
      { kind: "tool_schemas", id: "mcp:agent-swarm", label: "swarm tool schemas (2)", chars: 800 },
      { kind: "skills_listing", id: "harness:skills", label: "skills listing", chars: 100 },
    ],
    // System: 501 chars of ours + 100 of skills + 1,000 of harness base.
    harness: { systemChars: 1601, payloadChars: 4401, promptTokens },
  });

  test("merges with the session's worker manifest: exact base, exact tools", async () => {
    expect(
      (
        await post({
          sessionId: "sess-hook-1",
          provider: "pi-merge",
          toolLoading: "core",
          parts: workerParts,
        })
      ).status,
    ).toBe(200);
    const res = await post(hookBody("sess-hook-1", "pi-merge", 1320));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { seq: number }).seq).toBe(1);

    const hook = (await manifests()).find(
      (m) => m.sessionId === "sess-hook-1" && m.source === "harness-hook",
    )!;
    const byId = Object.fromEntries(hook.parts.map((part) => [part.id, part]));
    // Worker parts carry over; the estimated tool schemas give way to exact ones.
    expect(byId.persona?.chars).toBe(400);
    expect(byId.task_prompt?.chars).toBe(2000);
    expect(hook.parts.filter((part) => part.kind === "tool_schemas")).toEqual([
      expect.objectContaining({ id: "mcp:agent-swarm", chars: 800, fidelity: "exact" }),
    ]);
    expect(byId["harness:base"]).toMatchObject({ chars: 1000, fidelity: "exact" });
    // Parts cover the payload: 400 + 101 + 2000 + 1000 + 800 + 100 = 4401.
    expect(hook.parts.reduce((sum, part) => sum + part.chars, 0)).toBe(4401);
    // Own ratio: 1320 / (4401 / 4) = 1.1997...
    expect(hook.tokenRatio).toBeCloseTo(1320 / (4401 / 4), 6);
  });

  test("first-call message text beyond the task prompt is harness context", async () => {
    await post({
      sessionId: "sess-hook-msg",
      provider: "oc-msg",
      toolLoading: "all",
      parts: workerParts,
    });
    const body = hookBody("sess-hook-msg", "oc-msg", 1400);
    await post({ ...body, harness: { ...body.harness, firstMessageChars: 2300 } });
    const hook = (await manifests()).find(
      (m) => m.sessionId === "sess-hook-msg" && m.source === "harness-hook",
    )!;
    expect(hook.parts.find((part) => part.id === "harness:messages")).toMatchObject({
      chars: 300,
      fidelity: "exact",
    });
  });

  test("without a worker manifest the system prompt stays one exact part", async () => {
    await post(hookBody("sess-hook-orphan", "pi-orphan", 1100));
    const hook = (await manifests()).find((m) => m.sessionId === "sess-hook-orphan")!;
    expect(hook.seq).toBe(0);
    expect(hook.parts.find((part) => part.id === "harness:system")).toMatchObject({
      kind: "system_section",
      chars: 1501,
      fidelity: "exact",
    });
  });

  test("EMA: seeded by the first observation, alpha 0.2, bounded 0.5 to 2.0", async () => {
    const provider = "pi-ema";
    const ratioOf = async (sessionId: string) => {
      await post({ sessionId, provider, toolLoading: "none", parts: workerParts });
      return (await manifests()).find((m) => m.sessionId === sessionId)!.tokenRatio;
    };
    expect(await ratioOf("sess-ema-before")).toBe(1);

    // 4401 chars / 4 = 1100.25 est. tokens; 1320 real tokens → 1.1997.
    await post(hookBody("sess-ema-1", provider, 1320));
    const seeded = 1320 / 1100.25;
    expect(await ratioOf("sess-ema-after-1")).toBeCloseTo(seeded, 6);

    // An absurd observation clamps to 2.0 before the EMA step.
    await post(hookBody("sess-ema-2", provider, 100_000));
    const stepped = seeded + 0.2 * (2 - seeded);
    expect(await ratioOf("sess-ema-after-2")).toBeCloseTo(stepped, 6);
    const clampedHook = (await manifests()).find((m) => m.sessionId === "sess-ema-2")!;
    expect(clampedHook.tokenRatio).toBe(2);

    // Other providers are untouched: claude and codex stay at 1.0.
    expect(await getTokenRatio("claude")).toBe(1);
  });

  test("an operator-set ratio applies to worker manifests", async () => {
    await upsertKv({
      namespace: TOKEN_RATIO_KV_NAMESPACE,
      key: tokenRatioKey("codex-operator"),
      value: 1.3,
      valueType: "json",
    });
    await post({
      sessionId: "sess-operator",
      provider: "codex-operator",
      toolLoading: "none",
      parts: workerParts,
    });
    expect((await manifests()).find((m) => m.sessionId === "sess-operator")!.tokenRatio).toBe(1.3);
    await upsertKv({
      namespace: TOKEN_RATIO_KV_NAMESPACE,
      key: tokenRatioKey("codex-operator"),
      value: 9,
      valueType: "json",
    });
    expect(await getTokenRatio("codex-operator")).toBe(2);
  });

  test("harness-hook without harness totals is a 400", async () => {
    const { harness: _omit, ...body } = hookBody("sess-hook-bad", "pi", 1);
    expect((await post(body)).status).toBe(400);
  });

  test("concurrent observations all land in the sample count", async () => {
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => post(hookBody(`sess-fan-${i}`, "pi-fan", 1100))),
    );
    expect(nextTokenRatio(null, 1).samples).toBe(1);
    const stored = await recordTokenRatio("pi-fan", 1);
    expect(stored.samples).toBe(9);
  });
});
