import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  cancelQuietly,
  claimTask,
  createAssignedTask,
  readTask,
  registerWorker,
  UUID,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

async function readAgent(ctx: ScenarioContext, agentId: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/agents/${agentId}`);
  expectStatus(response, [200], `read agent ${agentId}`);
  return asRecord(response.json);
}

/** Worker-reported credential readiness, the roll-up behind /status/test-connection. */
async function credentialStatus(ctx: ScenarioContext): Promise<void> {
  // "grok" keeps this scenario's credential reports apart from every other harness.
  const agentId = await registerWorker(ctx, "creds", { harness_provider: "grok" });
  expect((await readAgent(ctx, agentId)).harnessProvider === "grok", "Agent is not on grok");

  let response = await ctx.api("PUT", `/api/agents/${agentId}/credential-status`, {
    body: { ready: false, missing: ["GROK_API_KEY"] },
  });
  expectStatus(response, [200], "report missing credentials");
  let agent = asRecord(response.json);
  expect(agent.status === "waiting_for_credentials", `Status is ${String(agent.status)}`);
  expect(
    JSON.stringify(agent.credentialMissing) === JSON.stringify(["GROK_API_KEY"]),
    "credentialMissing not stored",
  );

  response = await ctx.api("GET", `/api/agents/${agentId}/credential-status`);
  expectStatus(response, [200], "single credential status");
  let entry = asRecord(response.json);
  expect(
    entry.agentId === agentId &&
      entry.status === "waiting_for_credentials" &&
      entry.harnessProvider === "grok" &&
      JSON.stringify(entry.missing) === JSON.stringify(["GROK_API_KEY"]) &&
      entry.credStatus === null,
    `Unexpected credential status ${JSON.stringify(entry)}`,
  );
  response = await ctx.api("GET", "/api/agents/credential-status?status=waiting_for_credentials");
  expectStatus(response, [200], "bulk credential status, waiting filter");
  expect(
    asRecords(response.json, "agents").some((row) => row.agentId === agentId),
    "Bulk filter omitted the waiting agent",
  );
  response = await ctx.api("GET", "/api/agents/credential-status?status=busy");
  expectStatus(response, [200], "bulk credential status, busy filter");
  expect(
    !asRecords(response.json, "agents").some((row) => row.agentId === agentId),
    "Bulk busy filter returned the waiting agent",
  );
  expectStatus(
    await ctx.api("GET", "/api/agents/credential-status?status=nonsense"),
    [400],
    "bulk filter with an unknown status",
  );
  expectStatus(
    await ctx.api("GET", `/api/agents/${GHOST}/credential-status`),
    [404],
    "credential status of an unknown agent",
  );
  expectStatus(
    await ctx.api("PUT", `/api/agents/${GHOST}/credential-status`, { body: { ready: true } }),
    [404],
    "report credentials of an unknown agent",
  );
  expectStatus(
    await ctx.api("PUT", `/api/agents/${agentId}/credential-status`, { body: { ready: "yes" } }),
    [400],
    "malformed credential report",
  );

  // No live test yet: test-connection explains instead of failing the request.
  response = await ctx.api("POST", "/status/test-connection", { body: { provider: "grok" } });
  expectStatus(response, [200], "test-connection before any live test");
  expect(
    asRecord(response.json).ok === false && typeof asRecord(response.json).error === "string",
    "test-connection should report ok:false with an error before a live test",
  );

  const testedAt = Date.now();
  response = await ctx.api("PUT", `/api/agents/${agentId}/credential-status`, {
    body: {
      ready: true,
      missing: [],
      cred_status: {
        ready: true,
        missing: [],
        satisfiedBy: "env",
        reportedAt: testedAt,
        reportKind: "boot",
        liveTest: { ok: true, latency_ms: 123, testedAt },
      },
    },
  });
  expectStatus(response, [200], "report a passing live test");
  agent = asRecord(response.json);
  expect(agent.status === "idle", `Agent is ${String(agent.status)} after credentials arrived`);
  expect(agent.credentialMissing === null, "credentialMissing survived ready:true");
  entry = asRecord(
    asRecord((await ctx.api("GET", `/api/agents/${agentId}/credential-status`)).json).credStatus,
  );
  expect(
    entry.ready === true && asRecord(entry.liveTest).latency_ms === 123,
    "credStatus snapshot is not exposed",
  );
  response = await ctx.api("POST", "/status/test-connection", { body: { provider: "grok" } });
  expectStatus(response, [200], "test-connection after a passing live test");
  expect(
    asRecord(response.json).ok === true && asRecord(response.json).latency_ms === 123,
    `test-connection does not echo the reported live test: ${response.text}`,
  );

  response = await ctx.api("PUT", `/api/agents/${agentId}/credential-status`, {
    body: {
      cred_status: {
        ready: false,
        missing: ["GROK_API_KEY"],
        reportedAt: testedAt + 1000,
        liveTest: {
          ok: false,
          error: `bad key ${ctx.nonce}`,
          latency_ms: 9,
          testedAt: testedAt + 1000,
        },
      },
    },
  });
  expectStatus(response, [200], "report a failing live test");
  response = await ctx.api("POST", "/status/test-connection", { body: { provider: "grok" } });
  expect(
    asRecord(response.json).ok === false &&
      String(asRecord(response.json).error).includes(ctx.nonce),
    `test-connection did not surface the newest failing live test: ${response.text}`,
  );
  expectStatus(
    await ctx.api("POST", "/status/test-connection", { body: { provider: "not-a-harness" } }),
    [400],
    "test-connection with an unknown provider",
  );
  expectStatus(
    await ctx.api("POST", "/status/test-connection", { apiKey: null, body: { provider: "grok" } }),
    [401],
    "test-connection without credentials",
  );
  // The roll-up ignores offline agents.
  expectStatus(
    await ctx.api("POST", "/close", { agentId, body: {} }),
    [204],
    "close the credentials agent",
  );
}

/** Agent-bound worker tokens: mint, act as the agent, rotate, revoke. */
async function workerTokens(ctx: ScenarioContext): Promise<void> {
  const agentId = await registerWorker(ctx, "token");

  let response = await ctx.api("POST", `/api/agents/${agentId}/token`, { body: {} });
  expectStatus(response, [200], "mint worker token");
  let minted = asRecord(response.json);
  expect(
    minted.agentId === agentId && minted.agentCreated === false && minted.expiresAt === null,
    `Unexpected mint response ${JSON.stringify({ ...minted, plaintext: "<hidden>" })}`,
  );
  expect(
    typeof minted.plaintext === "string" && minted.plaintext.startsWith("aseph_"),
    "Minted plaintext has no aseph_ prefix",
  );
  expect(response.headers.get("cache-control") === "no-store", "Token response is cacheable");
  const firstTokenId = String(minted.tokenId);
  const firstToken = String(minted.plaintext);
  expect(
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM session_tokens WHERE id = ?", [
      firstTokenId,
    ])?.n === 1,
    "Minted token has no session_tokens row",
  );

  expectStatus(
    await ctx.api("POST", `/api/agents/${agentId}/token`, { body: {} }),
    [409],
    "second token while one is active",
  );
  expectStatus(
    await ctx.api("POST", `/api/agents/${GHOST}/token`, { body: {} }),
    [404],
    "mint for an unknown agent without a name",
  );
  response = await ctx.api("POST", `/api/agents/core-created-${ctx.nonce}/token`, {
    body: { name: `core-token-created-${ctx.nonce}` },
  });
  expectStatus(response, [200], "mint creates the agent when a name is given");
  minted = asRecord(response.json);
  expect(minted.agentCreated === true, "agentCreated is false for a new agent");
  const createdId = `core-created-${ctx.nonce}`;
  expect(
    ctx.db.get<{ status: string }>("SELECT status FROM agents WHERE id = ?", [createdId])
      ?.status === "offline",
    "Agent created by the token route is not offline",
  );
  expectStatus(
    await ctx.api("DELETE", `/api/agents/${createdId}/token`),
    [200],
    "revoke the created agent's token",
  );

  // The token authenticates as the agent, with no X-Agent-ID header.
  response = await ctx.api("GET", "/api/poll", { apiKey: firstToken });
  expectStatus(response, [200], "poll with the worker token");
  expect(asRecord(response.json).trigger === null, "Idle token agent received a trigger");
  response = await ctx.api("GET", `/api/agents/${agentId}`, { apiKey: firstToken });
  expectStatus(response, [200], "read self with the worker token");

  // A token cannot manage tokens.
  response = await ctx.api("POST", `/api/agents/${agentId}/token/rotate`, {
    apiKey: firstToken,
    body: {},
  });
  expectStatus(response, [403], "rotate with a worker token");
  expect(
    String(asRecord(response.json).error).includes("operator or user credentials"),
    "Token-managed 403 lacks reason",
  );

  response = await ctx.api("POST", `/api/agents/${agentId}/token/rotate`, {
    body: { graceSec: 0 },
  });
  expectStatus(response, [200], "rotate worker token");
  const rotated = asRecord(response.json);
  expect(rotated.tokenId !== firstTokenId, "Rotation reused the token id");
  expect(
    typeof rotated.plaintext === "string" && rotated.plaintext !== firstToken,
    "Rotation returned the old plaintext",
  );
  expect(typeof rotated.previousExpiresAt === "string", "Rotation lacks previousExpiresAt");
  const secondToken = String(rotated.plaintext);
  expectStatus(
    await ctx.api("GET", "/api/poll", { apiKey: secondToken }),
    [200],
    "poll with the rotated token",
  );
  const oldTokenGone = await pollUntil(
    async () => (await ctx.api("GET", "/api/poll", { apiKey: firstToken })).status === 401,
    10_000,
    250,
  );
  expect(oldTokenGone, "The previous token still works after graceSec 0");

  response = await ctx.api("DELETE", `/api/agents/${agentId}/token`);
  expectStatus(response, [200], "revoke worker tokens");
  expect(Number(asRecord(response.json).revoked) >= 1, "Revoke reported nothing revoked");
  expectStatus(
    await ctx.api("GET", "/api/poll", { apiKey: secondToken }),
    [401],
    "poll with the revoked token",
  );
  response = await ctx.api("DELETE", `/api/agents/${agentId}/token`);
  expectStatus(response, [200], "revoke again");
  expect(asRecord(response.json).revoked === 0, "A second revoke revoked something");
  expectStatus(
    await ctx.api("POST", `/api/agents/${agentId}/token/rotate`, { body: {} }),
    [404],
    "rotate without an active token",
  );
}

/** Ephemeral task and runtime tokens. */
async function sessionTokens(ctx: ScenarioContext): Promise<void> {
  const agentId = await registerWorker(ctx, "session-token");
  const taskId = await createAssignedTask(ctx, agentId, `session token task ${ctx.nonce}`);
  await claimTask(ctx, agentId, taskId);

  let response = await ctx.api("POST", "/api/sessions/tokens", {
    body: { agentId, taskId, ttlMs: 120_000 },
  });
  expectStatus(response, [200], "mint task token");
  const minted = asRecord(response.json);
  expect(
    typeof minted.tokenId === "string" &&
      typeof minted.plaintext === "string" &&
      minted.plaintext.startsWith("aseph_"),
    "Task token response is malformed",
  );
  const token = String(minted.plaintext);
  const tokenId = String(minted.tokenId);

  // The task token acts on its own task.
  response = await ctx.api("POST", `/api/tasks/${taskId}/progress`, {
    apiKey: token,
    body: { progress: `via task token ${ctx.nonce}` },
  });
  expectStatus(response, [200], "progress with a task token");
  expect(
    String((await readTask(ctx, taskId)).progress).includes(ctx.nonce),
    "Progress written with the task token was not stored",
  );

  // Validation and authorization.
  expectStatus(
    await ctx.api("POST", "/api/sessions/tokens", { body: { agentId, taskId } }),
    [400],
    "task token without ttlMs",
  );
  expectStatus(
    await ctx.api("POST", "/api/sessions/tokens", { body: { agentId } }),
    [400],
    "token without taskId or runtimeId",
  );
  expectStatus(
    await ctx.api("POST", "/api/sessions/tokens", {
      body: { agentId, taskId, runtimeId: "rt", ttlMs: 1000 },
    }),
    [400],
    "token with both taskId and runtimeId",
  );
  expectStatus(
    await ctx.api("POST", "/api/sessions/tokens", {
      apiKey: null,
      body: { agentId, taskId, ttlMs: 1000 },
    }),
    [401],
    "mint without credentials",
  );
  expectStatus(
    await ctx.api("POST", "/api/sessions/tokens", {
      apiKey: token,
      body: { agentId, taskId, ttlMs: 1000 },
    }),
    [401],
    "a task token cannot mint",
  );
  expectStatus(
    await ctx.api("DELETE", `/api/sessions/tokens/${tokenId}`, { apiKey: null }),
    [401],
    "revoke without credentials",
  );

  // A runtime token is minted by the operator and revoked the same way.
  response = await ctx.api("POST", "/api/sessions/tokens", {
    body: { agentId, runtimeId: `core-runtime-${ctx.nonce}` },
  });
  expectStatus(response, [200], "mint runtime token");
  const runtimeTokenId = String(asRecord(response.json).tokenId);
  expectStatus(
    await ctx.api("DELETE", `/api/sessions/tokens/${runtimeTokenId}`),
    [204],
    "revoke runtime token",
  );

  expectStatus(
    await ctx.api("DELETE", `/api/sessions/tokens/${tokenId}`),
    [204],
    "revoke task token",
  );
  expectStatus(
    await ctx.api("DELETE", `/api/sessions/tokens/${tokenId}`),
    [204],
    "revoke the task token again",
  );
  expectStatus(
    await ctx.api("GET", `/api/tasks/${taskId}`, { apiKey: token }),
    [401],
    "read with the revoked task token",
  );
  await cancelQuietly(ctx, taskId);
  expect(UUID.test(taskId), "Task id is not a UUID");
}

export const coreAgentAccess: Scenario = {
  name: "core-agent-access",
  order: 205,
  async run(ctx) {
    await credentialStatus(ctx);
    await workerTokens(ctx);
    await sessionTokens(ctx);
  },
};
