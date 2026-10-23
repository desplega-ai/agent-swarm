import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { closeDb, createAgent, initDb } from "../be/db";
import {
  AgentTokenExistsError,
  mintAgentToken,
  mintScriptRunToken,
  resolveSessionToken,
  revokeAgentTokens,
  revokeSessionToken,
} from "../be/users";

const synthetic = (label: string) => `script-run-token-${label}-${randomBytes(8).toString("hex")}`;

let agentId: string;
let otherId: string;

beforeAll(async () => {
  initDb(":memory:");
  agentId = (await createAgent({ name: synthetic("agent"), isLead: false, status: "idle" })).id;
  otherId = (await createAgent({ name: synthetic("other"), isLead: false, status: "idle" })).id;
});

afterAll(() => {
  closeDb();
});

describe("mintScriptRunToken", () => {
  test("resolves to the executing agent as an agent principal", async () => {
    const token = await mintScriptRunToken(agentId, 60_000);
    expect(token.plaintext.startsWith("aseph_")).toBe(true);

    const resolved = await resolveSessionToken(token.plaintext);
    expect(resolved).not.toBeNull();
    if (resolved?.kind !== "agent") throw new Error("expected an agent principal");
    expect(resolved.agentId).toBe(agentId);
    expect(resolved.tokenKind).toBe("agent");
    expect(resolved.taskId).toBeNull();
    expect(resolved.runtimeId).toBeNull();

    await revokeSessionToken(token.tokenId);
  });

  test("does not count as the agent's worker token", async () => {
    // A script run must be able to mint its token while the agent already
    // holds a worker token, and vice versa: the two lifecycles are separate.
    const worker = await mintAgentToken(agentId);
    const run = await mintScriptRunToken(agentId, 60_000);

    expect(run.tokenId).not.toBe(worker.tokenId);
    // The worker token is unique per agent; minting a second would throw. The
    // script run token sharing the agent did not trip that uniqueness.
    await expect(mintAgentToken(agentId)).rejects.toBeInstanceOf(AgentTokenExistsError);

    await revokeSessionToken(run.tokenId);
    await revokeAgentTokens(agentId);
  });

  test("survives a revoke of the agent's worker tokens", async () => {
    const worker = await mintAgentToken(otherId);
    const run = await mintScriptRunToken(otherId, 60_000);

    // Revoking the agent's worker tokens (worker-token revoke / rotate) must
    // not revoke a script run's in-flight token.
    await revokeAgentTokens(otherId);

    expect(await resolveSessionToken(worker.plaintext)).toBeNull();
    const stillValid = await resolveSessionToken(run.plaintext);
    expect(stillValid).not.toBeNull();
    expect(stillValid?.agentId).toBe(otherId);

    await revokeSessionToken(run.tokenId);
    expect(await resolveSessionToken(run.plaintext)).toBeNull();
  });
});
