import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDb, createAgent, createTaskExtended, initDb } from "../be/db";
import { mintRuntimeToken, mintSessionToken, resolveBySessionToken } from "../be/users";
import { resolveHttpRequestAuth } from "../http/auth";
import { handleSessions } from "../http/sessions";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { ACPAdapter } from "../providers/acp-adapter";
import { setRequestAuth } from "../utils/request-auth-context";
import { ACP_SDK_PATH, serveFakeAcpAgent } from "./acp-fake-agent";
import { listenOnFreePort } from "./test-net";
import { CHILD_PROCESS_TEST_BUDGET_MS } from "./test-proc";

const previousFlag = process.env.RUNTIME_POOLS_ENABLED;
const operatorKey = "runtime-child-cleanup-operator";

beforeAll(() => {
  initDb(":memory:");
  process.env.RUNTIME_POOLS_ENABLED = "true";
});

afterAll(() => {
  closeDb();
  if (previousFlag === undefined) delete process.env.RUNTIME_POOLS_ENABLED;
  else process.env.RUNTIME_POOLS_ENABLED = previousFlag;
});

async function startApi(onRevoke: (status: number) => void = () => {}) {
  const dispatch = async (req: IncomingMessage, res: ServerResponse) => {
    const auth = await resolveHttpRequestAuth(req, operatorKey);
    if (!auth) {
      res.writeHead(401).end();
      return;
    }
    setRequestAuth(req, auth);
    if (req.url === "/me") {
      res.writeHead(200).end();
      return;
    }
    await handleSessions(req, res, getPathSegments(req.url ?? ""), parseQueryParams(req.url ?? ""));
    if (req.method === "DELETE") onRevoke(res.statusCode);
    if (!res.writableEnded) res.writeHead(404).end();
  };
  const server = createServer((req, res) => {
    void dispatch(req, res).catch(() => res.writeHead(500).end());
  });
  const port = await listenOnFreePort(server);
  return {
    url: `http://127.0.0.1:${port}`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

for (const setupFails of [false, true]) {
  test(
    `ACP ${setupFails ? "setup failure" : "normal completion"} revokes its runtime child token`,
    async () => {
      const agent = await createAgent({ name: "ACP runtime", isLead: false, status: "idle" });
      const task = await createTaskExtended("ACP task", { agentId: agent.id });
      const parent = await mintRuntimeToken(agent.id, crypto.randomUUID(), 60_000);
      let resolveRevoke!: (status: number) => void;
      const revoked = new Promise<number>((resolve) => {
        resolveRevoke = resolve;
      });
      const api = await startApi(resolveRevoke);
      const script = join(tmpdir(), `runtime-child-${crypto.randomUUID()}.ts`);
      const capture = `${script}.auth`;
      await Bun.write(
        script,
        `
import { Readable, Writable } from "node:stream";
import { PROTOCOL_VERSION, agent, methods, ndJsonStream } from ${JSON.stringify(ACP_SDK_PATH)};
class Agent {
  async initialize() {
    return { protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: false } };
  }
  async newSession(params) {
    const swarm = params.mcpServers.find((server) => server.name === "swarm");
    const auth = swarm.headers.find((header) => header.name === "Authorization").value;
    await Bun.write(${JSON.stringify(capture)}, auth);
    if (${setupFails}) throw new Error("Deliberate setup failure");
    return { sessionId: "cleanup-session" };
  }
  async prompt() { return { stopReason: "end_turn" }; }
  async cancel() {}
}
${serveFakeAcpAgent("Agent")}
`,
      );
      try {
        const session = new ACPAdapter().createSession({
          prompt: "Complete the task",
          systemPrompt: "Test agent",
          model: "test-model",
          role: "worker",
          agentId: agent.id,
          taskId: task.id,
          apiUrl: api.url,
          apiKey: parent.plaintext,
          cwd: tmpdir(),
          logFile: `${script}.log`,
          env: {
            PATH: process.env.PATH ?? "",
            ACP_TARGET_COMMAND: "bun",
            ACP_TARGET_ARGS: JSON.stringify([script]),
          },
        });
        if (setupFails) await expect(session).rejects.toThrow("ACP target failed during startup");
        else expect((await (await session).waitForCompletion()).exitCode).toBe(0);
        expect(await revoked).toBe(204);
        const childBearer = await Bun.file(capture).text();
        expect(
          (await fetch(`${api.url}/me`, { headers: { Authorization: childBearer } })).status,
        ).toBe(401);
        expect(await resolveBySessionToken(parent.plaintext)).not.toBeNull();
      } finally {
        await api.close();
        for (const path of [script, capture, `${script}.log`])
          await Bun.file(path)
            .delete()
            .catch(() => {});
      }
    },
    CHILD_PROCESS_TEST_BUDGET_MS,
  );
}

test("runtime revocation requires both its agent and parent runtime and remains disabled with the flag off", async () => {
  const agent = await createAgent({ name: "Owner", isLead: false, status: "idle" });
  const other = await createAgent({ name: "Other", isLead: false, status: "idle" });
  const task = await createTaskExtended("Child task", { agentId: agent.id });
  const runtimeId = crypto.randomUUID();
  const parent = await mintRuntimeToken(agent.id, runtimeId, 60_000);
  const child = await mintSessionToken(agent.id, task.id, 60_000, {
    tokenId: parent.tokenId,
    runtimeId,
  });
  const sibling = await mintRuntimeToken(agent.id, crypto.randomUUID(), 60_000);
  const mismatchedAgent = await mintRuntimeToken(other.id, runtimeId, 60_000);
  const independentChild = await mintSessionToken(agent.id, task.id, 60_000);
  const api = await startApi();
  const revoke = (tokenId: string, bearer: string) =>
    fetch(`${api.url}/api/sessions/tokens/${tokenId}`, {
      method: "DELETE",
      headers: { Authorization: `Bearer ${bearer}` },
    });
  try {
    for (const bearer of [sibling.plaintext, mismatchedAgent.plaintext])
      expect((await revoke(child.tokenId, bearer)).status).toBe(403);
    expect((await revoke(independentChild.tokenId, parent.plaintext)).status).toBe(403);
    expect((await revoke(parent.tokenId, parent.plaintext)).status).toBe(403);
    expect((await revoke(crypto.randomUUID(), parent.plaintext)).status).toBe(403);
    expect((await revoke(child.tokenId, child.plaintext)).status).toBe(401);
    expect(await resolveBySessionToken(child.plaintext)).not.toBeNull();
    process.env.RUNTIME_POOLS_ENABLED = "false";
    expect((await revoke(child.tokenId, parent.plaintext)).status).toBe(401);
    expect(await resolveBySessionToken(child.plaintext)).not.toBeNull();
    process.env.RUNTIME_POOLS_ENABLED = "true";
    expect((await revoke(child.tokenId, parent.plaintext)).status).toBe(204);
    expect((await revoke(child.tokenId, parent.plaintext)).status).toBe(204);
    expect(await resolveBySessionToken(child.plaintext)).toBeNull();
    expect((await revoke(independentChild.tokenId, operatorKey)).status).toBe(204);
  } finally {
    process.env.RUNTIME_POOLS_ENABLED = "true";
    await api.close();
  }
});
