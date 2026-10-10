/**
 * `guidelines.allowMerge` renders in the agent prompt as "Auto-merge: Allowed", so changing it
 * needs the lead, the operator or a user. Other guideline fields stay editable by any agent.
 * Covers the update-repo tool and the POST/PUT /api/repos twins.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { closeDb, createAgent, createSwarmRepo, getSwarmRepoById, initDb } from "../be/db";
import { handleRepos } from "../http/repos";
import { registerUpdateRepoTool } from "../tools/repos";
import { type HttpRequestAuth, setRequestAuth } from "../utils/request-auth-context";
import { interleave } from "./write-gate";

const TEST_DB_PATH = "./test-repo-allow-merge-gate.sqlite";

const LEAD_ID = "aaaa3000-0000-4000-8000-000000000001";
const WORKER_ID = "bbbb3000-0000-4000-8000-000000000002";

type ToolResult = {
  structuredContent: { success: boolean; message: string };
  isError: boolean;
};

let mcp: McpServer;
let routeServer: Server;
let routeBaseUrl: string;
let repoSeq = 0;

const guidelines = (allowMerge: boolean | undefined, prChecks: string[] = ["bun test"]) => ({
  prChecks,
  mergeChecks: [],
  review: [],
  ...(allowMerge === undefined ? {} : { allowMerge }),
});

async function newRepo(allowMerge: boolean | null) {
  repoSeq += 1;
  return createSwarmRepo({
    url: `https://github.com/example/gate-${repoSeq}`,
    name: `gate-${repoSeq}`,
    guidelines: allowMerge === null ? undefined : guidelines(allowMerge),
  });
}

async function callUpdateRepo(
  callerAgentId: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  // biome-ignore lint/complexity/noBannedTypes: accessing internal MCP SDK type for test
  const tools = (mcp as unknown as { _registeredTools: Record<string, { handler: Function }> })
    ._registeredTools;
  const handler = tools["update-repo"]?.handler;
  if (!handler) throw new Error("update-repo not registered");
  const extra = {
    sessionId: "test-session",
    requestInfo: { headers: { "x-agent-id": callerAgentId } },
  };
  return (await handler(args, extra)) as ToolResult;
}

/** The swarm API key authenticates as the operator; workers add their X-Agent-ID on top of it. */
const KEYED_REQUEST: HttpRequestAuth = { kind: "operator", fingerprint: "test-key" };

/** What the other auth schemes resolve to, picked per request with the x-test-auth header. */
const AUTH_BY_SCHEME: Record<string, HttpRequestAuth> = {
  user: { kind: "user", userId: "a".repeat(32), user: {} as never },
  "agent-session": { kind: "agent", agentId: WORKER_ID, taskId: "task-1" },
};

async function api(
  method: "POST" | "PUT",
  path: string,
  caller: { agentId?: string; auth?: "user" | "agent-session" },
  body: Record<string, unknown>,
): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`${routeBaseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(caller.agentId ? { "X-Agent-ID": caller.agentId } : {}),
      ...(caller.auth ? { "x-test-auth": caller.auth } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // not there
    }
  }
}

beforeAll(async () => {
  await removeDbFiles();
  closeDb();
  initDb(TEST_DB_PATH);
  await createAgent({ id: LEAD_ID, name: "Gate Lead", isLead: true, status: "idle" });
  await createAgent({ id: WORKER_ID, name: "Gate Worker", isLead: false, status: "idle" });

  mcp = new McpServer({ name: "test-repo-allow-merge-gate", version: "1.0.0" });
  registerUpdateRepoTool(mcp);

  routeServer = createServer(async (req, res) => {
    setRequestAuth(req, AUTH_BY_SCHEME[String(req.headers["x-test-auth"])] ?? KEYED_REQUEST);
    const url = req.url ?? "/";
    const handled = await handleRepos(
      req,
      res,
      url.split("?")[0]?.split("/").filter(Boolean) ?? [],
      new URLSearchParams(url.split("?")[1] ?? ""),
      req.headers["x-agent-id"] as string | undefined,
    );
    if (!handled) res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => routeServer.listen(0, "127.0.0.1", resolve));
  const address = routeServer.address();
  if (!address || typeof address === "string") throw new Error("No TCP address");
  routeBaseUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    routeServer.close((error) => (error ? reject(error) : resolve())),
  );
  closeDb();
  await removeDbFiles();
});

describe("update-repo tool", () => {
  test("a worker cannot turn allowMerge on, and nothing is stored", async () => {
    const repo = await newRepo(false);
    const result = await callUpdateRepo(WORKER_ID, {
      id: repo.id,
      guidelines: guidelines(true),
    });

    expect(result.isError).toBe(true);
    expect(result.structuredContent.message).toContain("allowMerge");
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(false);
  });

  test("a worker cannot turn it on for a repo that has no guidelines yet", async () => {
    const repo = await newRepo(null);
    const result = await callUpdateRepo(WORKER_ID, { id: repo.id, guidelines: guidelines(true) });

    expect(result.isError).toBe(true);
    expect((await getSwarmRepoById(repo.id))?.guidelines).toBeNull();
  });

  test("a worker cannot turn it off or clear it either: the value is not theirs to change", async () => {
    const repo = await newRepo(true);

    const off = await callUpdateRepo(WORKER_ID, { id: repo.id, guidelines: guidelines(false) });
    expect(off.isError).toBe(true);
    const omitted = await callUpdateRepo(WORKER_ID, {
      id: repo.id,
      guidelines: guidelines(undefined),
    });
    expect(omitted.isError).toBe(true);
    const cleared = await callUpdateRepo(WORKER_ID, { id: repo.id, guidelines: null });
    expect(cleared.isError).toBe(true);

    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("a worker can still edit every other guideline field and the repo fields", async () => {
    const off = await newRepo(false);
    const edited = await callUpdateRepo(WORKER_ID, {
      id: off.id,
      guidelines: guidelines(false, ["bun run lint", "bun test"]),
      defaultBranch: "develop",
    });
    expect(edited.isError).toBe(false);
    expect((await getSwarmRepoById(off.id))?.guidelines?.prChecks).toEqual([
      "bun run lint",
      "bun test",
    ]);

    const none = await newRepo(null);
    const omitted = await callUpdateRepo(WORKER_ID, {
      id: none.id,
      guidelines: guidelines(undefined, ["bun test"]),
    });
    expect(omitted.isError).toBe(false);

    const on = await newRepo(true);
    const kept = await callUpdateRepo(WORKER_ID, {
      id: on.id,
      guidelines: guidelines(true, ["bun run lint"]),
    });
    expect(kept.isError).toBe(false);
    expect((await getSwarmRepoById(on.id))?.guidelines?.allowMerge).toBe(true);

    const rename = await callUpdateRepo(WORKER_ID, { id: on.id, name: "renamed-by-worker" });
    expect(rename.isError).toBe(false);
  });

  test("a lead can change allowMerge in both directions", async () => {
    const repo = await newRepo(false);
    const on = await callUpdateRepo(LEAD_ID, { id: repo.id, guidelines: guidelines(true) });
    expect(on.isError).toBe(false);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);

    const off = await callUpdateRepo(LEAD_ID, { id: repo.id, guidelines: guidelines(false) });
    expect(off.isError).toBe(false);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(false);
  });
});

describe("repo routes with an X-Agent-ID on the swarm key", () => {
  test("PUT /api/repos/:id refuses a worker's allowMerge change and allows a lead's", async () => {
    const repo = await newRepo(false);

    const denied = await api(
      "PUT",
      `/api/repos/${repo.id}`,
      { agentId: WORKER_ID },
      { guidelines: guidelines(true) },
    );
    expect(denied.status).toBe(403);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(false);

    const allowed = await api(
      "PUT",
      `/api/repos/${repo.id}`,
      { agentId: LEAD_ID },
      { guidelines: guidelines(true) },
    );
    expect(allowed.status).toBe(200);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("PUT /api/repos/:id still lets a worker edit other fields, and the operator change allowMerge", async () => {
    const repo = await newRepo(false);

    const edited = await api(
      "PUT",
      `/api/repos/${repo.id}`,
      { agentId: WORKER_ID },
      { guidelines: guidelines(false, ["bun run lint"]), defaultBranch: "develop" },
    );
    expect(edited.status).toBe(200);

    const operator = await api(
      "PUT",
      `/api/repos/${repo.id}`,
      {},
      { guidelines: guidelines(true) },
    );
    expect(operator.status).toBe(200);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("an aseph_ agent session is held to the same rule, and a user token is not", async () => {
    const repo = await newRepo(false);

    const session = await api(
      "PUT",
      `/api/repos/${repo.id}`,
      { auth: "agent-session" },
      { guidelines: guidelines(true) },
    );
    expect(session.status).toBe(403);

    const user = await api(
      "PUT",
      `/api/repos/${repo.id}`,
      { auth: "user", agentId: WORKER_ID },
      { guidelines: guidelines(true) },
    );
    expect(user.status).toBe(200);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("POST /api/repos refuses a worker creating a repo with allowMerge on", async () => {
    const denied = await api(
      "POST",
      "/api/repos",
      { agentId: WORKER_ID },
      {
        url: "https://github.com/example/created-by-worker-on",
        name: "created-by-worker-on",
        guidelines: guidelines(true),
      },
    );
    expect(denied.status).toBe(403);

    const plain = await api(
      "POST",
      "/api/repos",
      { agentId: WORKER_ID },
      {
        url: "https://github.com/example/created-by-worker-off",
        name: "created-by-worker-off",
        guidelines: guidelines(false),
      },
    );
    expect(plain.status).toBe(201);

    const lead = await api(
      "POST",
      "/api/repos",
      { agentId: LEAD_ID },
      {
        url: "https://github.com/example/created-by-lead-on",
        name: "created-by-lead-on",
        guidelines: guidelines(true),
      },
    );
    expect(lead.status).toBe(201);
  });
});

/**
 * An update compares the incoming allowMerge with the stored one, so a worker that resends the
 * value it read must not overwrite a lead's newer change. Each case holds one request just
 * before its write and commits the other meanwhile. The assertions hold for either serial order:
 * the lead's later write, or the worker's refusal after it, both leave the lead's value.
 */
describe("concurrent updates keep the allowMerge gate", () => {
  const UPDATE = /^UPDATE swarm_repos/;
  const workerEdit = guidelines(false, ["bun run lint"]);
  const leadEdit = guidelines(true);

  test("update-repo: a worker's resend of the value it read cannot overwrite a lead's change", async () => {
    const repo = await newRepo(false);
    const { second } = await interleave(
      UPDATE,
      () => callUpdateRepo(WORKER_ID, { id: repo.id, guidelines: workerEdit }),
      () => callUpdateRepo(LEAD_ID, { id: repo.id, guidelines: leadEdit }),
    );

    expect(second.isError).toBe(false);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("update-repo: a worker update queued behind a lead's change is refused, not applied", async () => {
    const repo = await newRepo(false);
    const { first, second } = await interleave(
      UPDATE,
      () => callUpdateRepo(LEAD_ID, { id: repo.id, guidelines: leadEdit }),
      () => callUpdateRepo(WORKER_ID, { id: repo.id, guidelines: workerEdit }),
    );

    expect(first.isError).toBe(false);
    expect(second.isError).toBe(true);
    expect(second.structuredContent.message).toContain("currently true");
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("PUT /api/repos/:id: a worker's resend of the value it read cannot overwrite a lead's change", async () => {
    const repo = await newRepo(false);
    const { second } = await interleave(
      UPDATE,
      () => api("PUT", `/api/repos/${repo.id}`, { agentId: WORKER_ID }, { guidelines: workerEdit }),
      () => api("PUT", `/api/repos/${repo.id}`, { agentId: LEAD_ID }, { guidelines: leadEdit }),
    );

    expect(second.status).toBe(200);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });

  test("PUT /api/repos/:id: a worker update queued behind a lead's change is refused, not applied", async () => {
    const repo = await newRepo(false);
    const { first, second } = await interleave(
      UPDATE,
      () => api("PUT", `/api/repos/${repo.id}`, { agentId: LEAD_ID }, { guidelines: leadEdit }),
      () => api("PUT", `/api/repos/${repo.id}`, { agentId: WORKER_ID }, { guidelines: workerEdit }),
    );

    expect(first.status).toBe(200);
    expect(second.status).toBe(403);
    expect((await getSwarmRepoById(repo.id))?.guidelines?.allowMerge).toBe(true);
  });
});
