import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { closeDb, createAgent, getDbClient, initDb } from "../be/db";
import {
  acquireScriptApiCredential,
  runScriptWithRunCredential,
} from "../be/scripts/run-credential";
import { resolveSessionToken } from "../be/users";
import { getApiKey, setApiKey } from "../utils/api-key";
import { SKIP_SANDBOX_SPAWN_TESTS } from "./sandbox-spawn-test-helpers";

const OPERATOR_KEY = `script-api-credential-operator-${randomBytes(8).toString("hex")}`;
const spawnTest = test.skipIf(SKIP_SANDBOX_SPAWN_TESTS);
const resources = { memoryMb: 2048, cpuTimeSec: 20 };
const savedExecutor = process.env.SCRIPT_EXECUTOR;
let agentId: string;

type ScriptRunTokenRow = { id: string; revokedAt: string | null };

/** The script-run tokens minted for `agentId`, oldest first. */
async function scriptRunTokens(id: string): Promise<ScriptRunTokenRow[]> {
  return await getDbClient().query<ScriptRunTokenRow>(
    "SELECT id, revokedAt FROM session_tokens WHERE agentId = ? AND scriptRun = 1 ORDER BY createdAt, rowid",
    [id],
  );
}

/**
 * Run `body` and assert it minted exactly one script-run token for the agent,
 * and that the token is revoked once the run is over.
 */
async function expectOneRevokedToken(body: () => Promise<void>): Promise<void> {
  const before = (await scriptRunTokens(agentId)).length;
  await body();
  const minted = (await scriptRunTokens(agentId)).slice(before);
  expect(minted).toHaveLength(1);
  expect(minted[0]?.revokedAt).not.toBeNull();
}

/** Resolve once the run's token has been minted and is still live. */
async function waitForLiveToken(): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if ((await scriptRunTokens(agentId)).some((row) => row.revokedAt === null)) return;
    await Bun.sleep(10);
  }
  throw new Error("no live script-run token appeared");
}

beforeAll(async () => {
  initDb(":memory:");
  setApiKey(OPERATOR_KEY);
  agentId = (
    await createAgent({
      name: `script-api-credential-${randomBytes(6).toString("hex")}`,
      isLead: false,
      status: "idle",
    })
  ).id;
});

afterEach(() => {
  if (savedExecutor === undefined) delete process.env.SCRIPT_EXECUTOR;
  else process.env.SCRIPT_EXECUTOR = savedExecutor;
});

afterAll(() => {
  closeDb();
});

describe("acquireScriptApiCredential", () => {
  test("hands a real agent a token scoped to that agent, not the operator key", async () => {
    const credential = await acquireScriptApiCredential(agentId);
    if (!credential.apiKey) throw new Error("expected a per-run token");
    try {
      expect(credential.apiKey).not.toBe(getApiKey());
      const resolved = await resolveSessionToken(credential.apiKey);
      if (resolved?.kind !== "agent") throw new Error("expected an agent principal");
      expect(resolved.agentId).toBe(agentId);
    } finally {
      await credential.release();
    }
    // The token is revoked once the run releases it.
    expect(await resolveSessionToken(credential.apiKey)).toBeNull();
  });

  test("refuses an unknown agent and sentinel without trusted authority", async () => {
    await expect(acquireScriptApiCredential("schedule")).rejects.toThrow("does not exist");
    await expect(acquireScriptApiCredential(crypto.randomUUID())).rejects.toThrow("does not exist");
    const { deleteAgent } = await import("../be/db/agents");
    const removed = await createAgent({
      name: "deleted-credential-fixture",
      isLead: false,
      status: "idle",
    });
    await deleteAgent(removed.id);
    await expect(acquireScriptApiCredential(removed.id)).rejects.toThrow("does not exist");
  });

  test("mints an operator token only with explicit authority and preserves provenance", async () => {
    const credential = await acquireScriptApiCredential(
      "schedule",
      { sourceScriptRunId: "fixture-run" },
      { kind: "operator" },
    );
    try {
      expect(credential.apiKey === getApiKey()).toBe(false);
      const resolved = await resolveSessionToken(credential.apiKey);
      expect(resolved?.kind).toBe("operator");
      expect(resolved && "sourceScriptRunId" in resolved && resolved.sourceScriptRunId).toBe(
        "fixture-run",
      );
    } finally {
      await credential.release();
    }
    expect(await resolveSessionToken(credential.apiKey)).toBeNull();
  });
});

describe("runScriptWithRunCredential revokes the run's token however the run ends", () => {
  test("refuses missing principals before execution with a script result", async () => {
    const input = { agentId: crypto.randomUUID(), source: "export default () => 42" };
    const agent = await runScriptWithRunCredential(input);
    const user = await runScriptWithRunCredential(
      input,
      {},
      { kind: "user", userId: crypto.randomUUID() },
    );
    expect(agent).toMatchObject({
      error: "executor_error",
      exitCode: 1,
      stderr: "Script executing agent does not exist",
    });
    expect(user).toMatchObject({
      error: "executor_error",
      exitCode: 1,
      stderr: "Script executing user is inactive",
    });
  });

  spawnTest("success", async () => {
    await expectOneRevokedToken(async () => {
      const output = await runScriptWithRunCredential({
        agentId,
        egressSecrets: [],
        resources,
        source: "export default async () => 'ok';",
      });
      expect(output.error).toBeUndefined();
      expect(output.result).toBe("ok");
    });
  });

  spawnTest("the script throws", async () => {
    await expectOneRevokedToken(async () => {
      const output = await runScriptWithRunCredential({
        agentId,
        egressSecrets: [],
        resources,
        source: "export default async () => { throw new Error('boom'); };",
      });
      expect(output.runtimeError?.message).toContain("boom");
    });
  });

  test("the run itself throws", async () => {
    // An executor that cannot start makes runScript reject after the token
    // was minted; the token must still be revoked.
    process.env.SCRIPT_EXECUTOR = "no-such-executor";
    await expectOneRevokedToken(async () => {
      await expect(
        runScriptWithRunCredential({
          agentId,
          egressSecrets: [],
          source: "export default async () => 'never runs';",
        }),
      ).rejects.toThrow("Unknown SCRIPT_EXECUTOR");
    });
  });

  spawnTest("timeout", async () => {
    await expectOneRevokedToken(async () => {
      const output = await runScriptWithRunCredential({
        agentId,
        egressSecrets: [],
        timeoutMs: 1_000,
        resources,
        source: "export default async () => new Promise(() => {});",
      });
      expect(output.error).toBe("timeout");
    });
  });

  spawnTest("abort", async () => {
    await expectOneRevokedToken(async () => {
      const controller = new AbortController();
      const run = runScriptWithRunCredential({
        agentId,
        egressSecrets: [],
        signal: controller.signal,
        resources,
        source: "export default async () => new Promise(() => {});",
      });
      // Abort mid-run: the token is live and the script has had time to start.
      await waitForLiveToken();
      await Bun.sleep(200);
      controller.abort();
      const output = await run;
      expect(output.error).toBe("killed");
    });
  });
});

describe("operator run authority", () => {
  test("unknown identities and sentinel labels do not grant authority", async () => {
    await expect(acquireScriptApiCredential("schedule")).rejects.toThrow("does not exist");
    await expect(acquireScriptApiCredential(crypto.randomUUID())).rejects.toThrow("does not exist");
  });

  test("HTTP authentication, provenance, expiry and realtime revocation", async () => {
    const { createServer } = await import("node:http");
    const { WebSocket } = await import("ws");
    const { attachRealtimeTransport } = await import("../realtime/transport");
    const { resolveHttpRequestAuth } = await import("../http/auth");
    const { mintOperatorScriptRunToken, fingerprintApiKey, revokeSessionToken } = await import(
      "../be/users"
    );
    const { listenOnFreePort } = await import("./test-net");
    const provenance = { sourceStepId: crypto.randomUUID(), objectChain: ["fixture"], depth: 1 };
    const credential = await acquireScriptApiCredential("workflow", provenance, {
      kind: "operator",
    });
    const principal = await resolveSessionToken(credential.apiKey);
    expect(principal?.kind).toBe("operator");
    if (principal?.kind !== "operator") throw new Error("Expected operator principal");
    expect(principal.fingerprint === fingerprintApiKey(OPERATOR_KEY)).toBe(true);
    expect(principal.sourceStepId).toBe(provenance.sourceStepId);
    expect(principal.objectChain).toEqual(["fixture"]);
    expect(credential.apiKey === OPERATOR_KEY).toBe(false);
    const { beginRequestAuthScope, setRequestAuth } = await import("../utils/request-auth-context");
    const { handleUsers } = await import("../http/users");
    const server = createServer((req, res) => {
      beginRequestAuthScope();
      void resolveHttpRequestAuth(req, OPERATOR_KEY)
        .then(async (auth) => {
          setRequestAuth(req, auth);
          if (auth && req.method === "POST" && req.url === "/api/users") {
            await handleUsers(req, res, ["api", "users"], new URLSearchParams());
            return;
          }
          res.writeHead(auth ? 200 : 401);
          res.end();
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
    const detach = attachRealtimeTransport(server);
    const port = await listenOnFreePort(server);
    let ws: InstanceType<typeof WebSocket> | undefined;
    try {
      const request = () =>
        fetch(`http://127.0.0.1:${port}/`, {
          headers: { Authorization: `Bearer ${credential.apiKey}` },
        });
      expect((await request()).status).toBe(200);
      const audit = [];
      for (const key of [OPERATOR_KEY, credential.apiKey]) {
        const response = await fetch(`http://127.0.0.1:${port}/api/users`, {
          method: "POST",
          headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
          body: JSON.stringify({
            name: "Audit fixture",
            email: `audit-${crypto.randomUUID()}@example.invalid`,
            dailyBudgetUsd: 10,
          }),
        });
        expect(response.status).toBe(200);
        const { user } = (await response.json()) as { user: { id: string } };
        const row = await getDbClient().get<{ actor: string; runProvenance: string | null }>(
          'SELECT actor, "runProvenance" FROM user_identity_events WHERE "userId" = ? AND "eventType" = ?',
          [user.id, "budget_changed"],
        );
        audit.push(row);
      }
      expect(audit[0]?.actor).toBe(`operator:${fingerprintApiKey(OPERATOR_KEY)}`);
      expect(audit[1]?.actor).toBe(audit[0]?.actor);
      expect(audit[0]?.runProvenance).toBeNull();
      expect(JSON.parse(audit[1]?.runProvenance ?? "null")).toEqual(provenance);
      ws = new WebSocket(`ws://127.0.0.1:${port}/api/realtime`, {
        headers: { Authorization: `Bearer ${credential.apiKey}` },
      });
      await new Promise<void>((resolve, reject) => {
        ws!.once("message", () => resolve());
        ws!.once("error", reject);
      });
      const closed = new Promise<number>((resolve) => ws!.once("close", resolve));
      await credential.release();
      expect(await closed).toBe(1008);
      expect((await request()).status).toBe(401);
      const expired = await mintOperatorScriptRunToken("fixture", 1, provenance);
      await Bun.sleep(10);
      expect(await resolveSessionToken(expired.plaintext)).toBeNull();
      await revokeSessionToken(expired.tokenId);
    } finally {
      ws?.terminate();
      await credential.release();
      detach();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

test("durable broker retains agent authority after the inline credential is revoked", async () => {
  const { createScriptRun } = await import("../be/db");
  const { getStorage } = await import("../be/storage");
  const { setScriptRunExecutor, startScriptRunProcess } = await import(
    "../script-workflows/supervisor"
  );
  const { localProcessScriptExecutor } = await import("../script-workflows/executor");
  const parent = await acquireScriptApiCredential(agentId);
  const { run } = await createScriptRun({
    id: crypto.randomUUID(),
    agentId,
    source: "export default async () => null",
    args: {},
  });
  await getStorage().repos.scripts.setScriptRunPrincipal(
    run.id,
    JSON.stringify({ kind: "agent", agentId }),
  );
  const exit = Promise.withResolvers<{ exitCode: number; stderr: string; terminated: boolean }>();
  let brokerBearer: string | undefined;
  let launches = 0;
  setScriptRunExecutor({
    start: async (input) => {
      brokerBearer = input.apiKey;
      launches++;
      return {
        pid: 0,
        tmpdir: "",
        startedAtMs: Date.now(),
        exited: exit.promise,
        terminate: async () => {},
        cleanup: async () => {},
      };
    },
    isRunning: () => false,
    terminatePid: async () => {},
  });
  try {
    await Promise.all([
      startScriptRunProcess(run, "http://127.0.0.1"),
      startScriptRunProcess(run, "http://127.0.0.1"),
    ]);
    expect(launches).toBe(1);
    await parent.release();
    expect(await resolveSessionToken(parent.apiKey)).toBeNull();
    if (!brokerBearer) throw new Error("Expected broker credential");
    expect(brokerBearer === OPERATOR_KEY).toBe(false);
    const broker = await resolveSessionToken(brokerBearer);
    expect(broker?.kind).toBe("agent");
    expect(broker && "agentId" in broker && broker.agentId).toBe(agentId);
    expect(broker && "sourceScriptRunId" in broker && broker.sourceScriptRunId).toBe(run.id);
  } finally {
    exit.resolve({ exitCode: 0, stderr: "", terminated: true });
    await parent.release();
    setScriptRunExecutor(localProcessScriptExecutor);
  }
  for (let i = 0; i < 100 && brokerBearer && (await resolveSessionToken(brokerBearer)); i++)
    await Bun.sleep(10);
  expect(brokerBearer && (await resolveSessionToken(brokerBearer))).toBeNull();
});

test("user authority stays a user and refuses deleted users", async () => {
  const { findOrCreateUserByEmail, resolveUserToken } = await import("../be/users");
  const { user } = await findOrCreateUserByEmail(
    `phase2-${crypto.randomUUID()}@example.invalid`,
    {},
    { kind: "system", id: "phase2-fixture" },
  );
  const provenance = { sourceStepId: crypto.randomUUID() };
  const credential = await acquireScriptApiCredential("workflow", provenance, {
    kind: "user",
    userId: user.id,
  });
  try {
    expect(await resolveSessionToken(credential.apiKey)).toBeNull();
    const resolved = await resolveUserToken(credential.apiKey);
    expect(resolved?.user?.id).toBe(user.id);
    expect(resolved?.provenance).toEqual(provenance);
    const { can } = await import("../rbac");
    expect(
      can({
        principal: { kind: "user", userId: user.id },
        verb: "config.read.secrets",
        source: "http",
      }).allow,
    ).toBe(false);
    await expect(
      acquireScriptApiCredential("workflow", {}, { kind: "user", userId: crypto.randomUUID() }),
    ).rejects.toThrow("inactive");
  } finally {
    await credential.release();
  }
  expect(await resolveUserToken(credential.apiKey)).toBeNull();
});

test("durable credentials preserve the launch session's task or runtime and expire with it", async () => {
  const { mintSessionToken, mintRuntimeToken, revokeSessionToken } = await import("../be/users");
  const taskId = crypto.randomUUID();
  const runtimeId = crypto.randomUUID();
  const task = await mintSessionToken(agentId, taskId, 60_000);
  const runtime = await mintRuntimeToken(agentId, runtimeId, 60_000);
  for (const parent of [task, runtime]) {
    const authority = { kind: "agent", agentId, parentTokenId: parent.tokenId } as const;
    const broker = await acquireScriptApiCredential(
      agentId,
      { sourceScriptRunId: "test-run" },
      authority,
    );
    try {
      const original = await resolveSessionToken(parent.plaintext);
      const delegated = await resolveSessionToken(broker.apiKey);
      if (original?.kind !== "agent" || delegated?.kind !== "agent")
        throw new Error("Expected agent sessions");
      expect(delegated.tokenKind).toBe(parent === task ? "task" : "runtime");
      expect(delegated.taskId).toBe(original.taskId);
      expect(delegated.runtimeId).toBe(original.runtimeId);
      expect(delegated.expiresAt).toBe(original.expiresAt);
      expect(delegated.sourceScriptRunId).toBe("test-run");
      expect(delegated.brokerTokenId).toBeDefined();
      await revokeSessionToken(parent.tokenId);
      expect(await resolveSessionToken(broker.apiKey)).toBeNull();
      await expect(acquireScriptApiCredential(agentId, {}, authority)).rejects.toThrow(
        "no longer active",
      );
    } finally {
      await broker.release();
      await revokeSessionToken(parent.tokenId);
    }
  }
});

test("a failed launch write terminates the guest and releases its credential", async () => {
  const { createScriptRun } = await import("../be/db");
  const { getStorage } = await import("../be/storage");
  const { setScriptRunExecutor, startScriptRunProcess } = await import(
    "../script-workflows/supervisor"
  );
  const { localProcessScriptExecutor } = await import("../script-workflows/executor");
  const { run } = await createScriptRun({
    id: crypto.randomUUID(),
    agentId,
    source: "export default () => null",
    args: null,
  });
  const scripts = getStorage().repos.scripts;
  await scripts.setScriptRunPrincipal(run.id, JSON.stringify({ kind: "agent", agentId }));
  const write = spyOn(scripts, "updateScriptRun").mockRejectedValueOnce(
    new Error("Fixture storage unavailable"),
  );
  const exit = Promise.withResolvers<{ exitCode: number; stderr: string; terminated: boolean }>();
  let terminated = false;
  let cleaned = 0;
  setScriptRunExecutor({
    async start() {
      return {
        pid: null,
        tmpdir: "",
        startedAtMs: Date.now(),
        exited: exit.promise,
        async terminate() {
          terminated = true;
          exit.resolve({ exitCode: 0, stderr: "", terminated: true });
        },
        async cleanup() {
          cleaned++;
        },
      };
    },
    isRunning: () => false,
    terminatePid: async () => {},
  });
  try {
    await expectOneRevokedToken(async () => {
      await expect(startScriptRunProcess(run, "http://127.0.0.1")).rejects.toThrow(
        "Fixture storage unavailable",
      );
    });
    expect(terminated).toBe(true);
    expect(cleaned).toBe(1);
  } finally {
    write.mockRestore();
    setScriptRunExecutor(localProcessScriptExecutor);
  }
});

test("historical replay authority belongs to one journal", async () => {
  const { acquireLegacyJournalCredential, resolveLegacyJournalCredential } = await import(
    "../be/scripts/legacy-journal-credential"
  );
  const runId = crypto.randomUUID();
  const grant = acquireLegacyJournalCredential(runId, agentId, 60_000);
  const journal = ["api", "internal", "script-runs", runId];
  try {
    expect(
      resolveLegacyJournalCredential(grant.apiKey, "GET", [...journal, "steps", "read"])?.kind,
    ).toBe("agent");
    expect(resolveLegacyJournalCredential(grant.apiKey, "POST", [...journal, "status"])?.kind).toBe(
      "agent",
    );
    expect(
      resolveLegacyJournalCredential(grant.apiKey, "POST", [
        "api",
        "internal",
        "script-runs",
        crypto.randomUUID(),
        "status",
      ]),
    ).toBeNull();
    expect(
      resolveLegacyJournalCredential(grant.apiKey, "POST", [...journal, "agent-task"]),
    ).toBeNull();
  } finally {
    await grant.release();
  }
  expect(resolveLegacyJournalCredential(grant.apiKey, "POST", [...journal, "status"])).toBeNull();
});
