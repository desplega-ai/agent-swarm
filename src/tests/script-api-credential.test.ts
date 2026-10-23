import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
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

  test("mints nothing for a system run with no real agent", async () => {
    // Scheduler and workflow script runs pass sentinel ids like "schedule" /
    // "workflow" when there is no owning agent; runScript then falls back to
    // the operator key.
    const credential = await acquireScriptApiCredential("schedule");
    try {
      expect(credential.apiKey).toBeUndefined();
      expect(await scriptRunTokens("schedule")).toHaveLength(0);
    } finally {
      await credential.release();
    }
  });
});

describe("runScriptWithRunCredential revokes the run's token however the run ends", () => {
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
