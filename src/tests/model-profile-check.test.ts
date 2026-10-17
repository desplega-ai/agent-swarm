// checkProfileForAgent: one case per state per check row (harness, model,
// harness-credentials, credential-allowlist), and no secret value in any row.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import {
  closeDb,
  createAgent,
  createSwarmRepo,
  getDbClient,
  initDb,
  upsertSwarmConfig,
} from "../be/db";
import { updateAgentCredStatus } from "../be/db/agents";
import { createModelProfile, taskProfileError } from "../be/db/model-profiles";
import { checkProfileForAgent, formatProfileCheckFailures } from "../be/model-profile-check";
import type { AgentCredStatus, ProfileCheckResult, ProfileCheckRow } from "../types";

const TEST_DB_PATH = "./test-model-profile-check.sqlite";
const oldEncryptionKey = process.env.SECRETS_ENCRYPTION_KEY;

// Two pooled keys; only the last five characters may ever surface.
const KEY_A = "sk-ant-oat01-secret-material-aaaaaaaa-11111";
const KEY_B = "sk-ant-oat01-secret-material-bbbbbbbb-22222";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

function report(overrides: Partial<AgentCredStatus> = {}): AgentCredStatus {
  return {
    ready: true,
    missing: [],
    satisfiedBy: "env",
    hint: null,
    liveTest: null,
    latestModel: null,
    reportedAt: Date.now(),
    reportKind: "boot",
    bedrock: null,
    acp: null,
    ...overrides,
  };
}

async function agent(harnessProvider: "claude" | "codex" | "pi", cred?: AgentCredStatus) {
  const created = await createAgent({
    name: `check-${harnessProvider}-${crypto.randomUUID().slice(0, 8)}`,
    isLead: false,
    status: "idle",
    harnessProvider,
  });
  if (cred) await updateAgentCredStatus(created.id, cred);
  return created.id;
}

async function check(agentId: string, profile: string): Promise<ProfileCheckResult> {
  const result = await checkProfileForAgent(agentId, profile);
  if (!result) throw new Error(`no result for ${profile}`);
  return result;
}

function row(result: ProfileCheckResult, name: ProfileCheckRow["check"]) {
  return result.profiles[0]?.checks.find((r) => r.check === name);
}

async function pool(agentId: string, key: string, value: string): Promise<void> {
  await upsertSwarmConfig({
    scope: "agent",
    scopeId: agentId,
    key,
    value,
    isSecret: true,
    exportToEnv: true,
  });
}

beforeAll(async () => {
  process.env.SECRETS_ENCRYPTION_KEY ??= Buffer.alloc(32, 7).toString("base64");
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
  if (oldEncryptionKey === undefined) delete process.env.SECRETS_ENCRYPTION_KEY;
  else process.env.SECRETS_ENCRYPTION_KEY = oldEncryptionKey;
});

beforeEach(async () => {
  const client = getDbClient();
  await client.run("DELETE FROM agent_tasks");
  await client.run("DELETE FROM scheduled_tasks");
  await client.run("DELETE FROM swarm_config");
  await client.run("DELETE FROM swarm_repos");
  await client.run("DELETE FROM api_key_status");
  await client.run("DELETE FROM agents");
  await client.run("DELETE FROM model_profiles");
  await createModelProfile({ name: "claude-opus", harness: "claude", model: "opus" });
  await createModelProfile({ name: "codex-sol", harness: "codex", model: "gpt-5.6-sol" });
});

describe("unknown inputs", () => {
  test("an unknown agent or profile is null", async () => {
    const id = await agent("claude");
    expect(await checkProfileForAgent(id, "no-such-profile")).toBeNull();
    expect(await checkProfileForAgent(crypto.randomUUID(), "claude-opus")).toBeNull();
  });
});

describe("harness", () => {
  test("the profile's harness on the agent's harness passes", async () => {
    const result = await check(await agent("claude", report()), "claude-opus");
    expect(row(result, "harness")).toEqual({ check: "harness", state: "pass" });
    expect(result.ok).toBe(true);
    expect(result.profiles).toHaveLength(1);
  });

  test("another harness's profile fails, naming both harnesses", async () => {
    const id = await agent("claude", report());
    const result = await check(id, "codex-sol");
    expect(row(result, "harness")?.state).toBe("fail");
    expect(row(result, "harness")?.detail).toContain("codex");
    expect(row(result, "harness")?.detail).toContain("claude");
    expect(result.ok).toBe(false);
    expect(result.profiles[0]?.ok).toBe(false);
    expect(formatProfileCheckFailures(result)).toContain('Model profile "codex-sol" fails harness');
  });

  test("the harness override judges a PATCH that switches the harness", async () => {
    const id = await agent("claude", report());
    const result = await checkProfileForAgent(id, "codex-sol", { harness: "codex" });
    expect(row(result as ProfileCheckResult, "harness")?.state).toBe("pass");
    // The worker's report is for claude, so it cannot vouch for codex yet.
    expect(row(result as ProfileCheckResult, "harness-credentials")?.state).toBe("unverified");
  });
});

describe("model", () => {
  test("a catalogued claude model passes", async () => {
    const result = await check(await agent("claude", report()), "claude-opus");
    expect(row(result, "model")?.state).toBe("pass");
  });

  test("a codex model on a claude profile fails", async () => {
    await createModelProfile({ name: "claude-wrong", harness: "claude", model: "gpt-5.6-sol" });
    const result = await check(await agent("claude", report()), "claude-wrong");
    expect(row(result, "model")?.state).toBe("fail");
    expect(result.ok).toBe(false);
  });

  test("a custom id is unverified", async () => {
    await createModelProfile({
      name: "claude-gateway",
      harness: "claude",
      model: "my-gateway-model",
      allowCustomModel: true,
    });
    const result = await check(await agent("claude", report()), "claude-gateway");
    expect(row(result, "model")).toEqual({
      check: "model",
      state: "unverified",
      detail: "custom model id",
    });
    expect(result.ok).toBe(true);
  });
});

describe("harness-credentials", () => {
  test("a ready worker report passes", async () => {
    const result = await check(await agent("claude", report()), "claude-opus");
    expect(row(result, "harness-credentials")?.state).toBe("pass");
  });

  test("a report with ready=false fails, listing the missing vars", async () => {
    const id = await agent(
      "claude",
      report({ ready: false, missing: ["CLAUDE_CODE_OAUTH_TOKEN"], satisfiedBy: null }),
    );
    const result = await check(id, "claude-opus");
    expect(row(result, "harness-credentials")).toEqual({
      check: "harness-credentials",
      state: "fail",
      detail: "missing CLAUDE_CODE_OAUTH_TOKEN",
    });
    expect(result.ok).toBe(false);
  });

  test("no report is unverified", async () => {
    const result = await check(await agent("claude"), "claude-opus");
    expect(row(result, "harness-credentials")).toEqual({
      check: "harness-credentials",
      state: "unverified",
      detail: "worker has not reported",
    });
    expect(result.ok).toBe(true);
  });

  test("a helmcode model on pi with no HELMCODE_API_KEY anywhere is unverified", async () => {
    await createModelProfile({
      name: "pi-helmcode",
      harness: "pi",
      model: "helmcode/glm5.3",
      allowCustomModel: true,
    });
    const id = await agent("pi", report());
    const result = await check(id, "pi-helmcode");
    expect(row(result, "harness-credentials")?.state).toBe("unverified");
    expect(row(result, "harness-credentials")?.detail).toContain("HELMCODE_API_KEY");
    expect(result.ok).toBe(true);

    // Control: the key in the agent's config makes it pass.
    await pool(id, "HELMCODE_API_KEY", "hc-secret-value-12345");
    const withKey = await check(id, "pi-helmcode");
    expect(row(withKey, "harness-credentials")?.state).toBe("pass");
    expect(JSON.stringify(withKey)).not.toContain("hc-secret-value-12345");
  });
});

describe("credential-allowlist", () => {
  test("no allowlist means no row", async () => {
    const result = await check(await agent("claude", report()), "claude-opus");
    expect(row(result, "credential-allowlist")).toBeUndefined();
  });

  test("every listed suffix matched passes", async () => {
    await createModelProfile({
      name: "claude-pinned",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["11111", "22222"] },
    });
    const id = await agent("claude", report());
    await pool(id, "CLAUDE_CODE_OAUTH_TOKEN", `${KEY_A},${KEY_B}`);
    const result = await check(id, "claude-pinned");
    expect(row(result, "credential-allowlist")).toEqual({
      check: "credential-allowlist",
      state: "pass",
    });
    expect(result.ok).toBe(true);
  });

  test("a partial match warns, naming the missing suffix", async () => {
    await createModelProfile({
      name: "claude-partial",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["11111", "99999"] },
    });
    const id = await agent("claude", report());
    await pool(id, "CLAUDE_CODE_OAUTH_TOKEN", `${KEY_A},${KEY_B}`);
    const result = await check(id, "claude-partial");
    expect(row(result, "credential-allowlist")?.state).toBe("warn");
    expect(row(result, "credential-allowlist")?.detail).toContain("99999");
    expect(result.ok).toBe(true);
    expect(formatProfileCheckFailures(result)).toBe("");
  });

  test("no match fails, naming the var", async () => {
    await createModelProfile({
      name: "claude-none",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["zzzzz"] },
    });
    const id = await agent("claude", report());
    await pool(id, "CLAUDE_CODE_OAUTH_TOKEN", `${KEY_A},${KEY_B}`);
    const result = await check(id, "claude-none");
    expect(row(result, "credential-allowlist")?.state).toBe("fail");
    expect(result.ok).toBe(false);
    expect(formatProfileCheckFailures(result)).toContain("CLAUDE_CODE_OAUTH_TOKEN");
  });

  test("env-only: an api_key_status match passes, no match is unverified", async () => {
    await createModelProfile({
      name: "claude-env",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["11111"] },
    });
    const id = await agent("claude", report());
    const before = await check(id, "claude-env");
    expect(row(before, "credential-allowlist")?.state).toBe("unverified");

    await getDbClient().run(
      "INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId) VALUES (?, ?, 0, 'global', '')",
      ["CLAUDE_CODE_OAUTH_TOKEN", "11111"],
    );
    const after = await check(id, "claude-env");
    expect(row(after, "credential-allowlist")?.state).toBe("pass");

    // Another agent's key usage does not vouch for this one.
    await getDbClient().run("DELETE FROM api_key_status");
    await getDbClient().run(
      "INSERT INTO api_key_status (keyType, keySuffix, keyIndex, scope, scopeId) VALUES (?, ?, 0, 'agent', ?)",
      ["CLAUDE_CODE_OAUTH_TOKEN", "11111", crypto.randomUUID()],
    );
    expect(row(await check(id, "claude-env"), "credential-allowlist")?.state).toBe("unverified");
  });

  // The worker loads a task's repo-scoped config over the agent's (repo > agent),
  // so a check for that task judges the same pool.
  test("a repo-scoped pool overrides the agent's for a task in that repo", async () => {
    await createModelProfile({
      name: "claude-repo-key",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["22222"] },
    });
    const id = await agent("claude", report());
    await pool(id, "CLAUDE_CODE_OAUTH_TOKEN", KEY_A);
    const repo = await createSwarmRepo({ url: "https://github.com/acme/widgets", name: "widgets" });
    await upsertSwarmConfig({
      scope: "repo",
      scopeId: repo.id,
      key: "CLAUDE_CODE_OAUTH_TOKEN",
      value: KEY_B,
      isSecret: true,
      exportToEnv: true,
    });

    expect((await check(id, "claude-repo-key")).ok).toBe(false);
    const inRepo = await checkProfileForAgent(id, "claude-repo-key", { vcsRepo: "acme/widgets" });
    expect(inRepo?.ok).toBe(true);
    expect(row(inRepo!, "credential-allowlist")?.state).toBe("pass");
    expect(
      await taskProfileError({ profile: "claude-repo-key", agentId: id, vcsRepo: "acme/widgets" }),
    ).toBeNull();
    expect(await taskProfileError({ profile: "claude-repo-key", agentId: id })).toContain(
      "credential-allowlist",
    );
  });

  test("no output contains a decrypted value", async () => {
    await createModelProfile({
      name: "claude-secret",
      harness: "claude",
      model: "opus",
      credentials: { CLAUDE_CODE_OAUTH_TOKEN: ["11111", "zzzzz"] },
    });
    const id = await agent("claude", report());
    await pool(id, "CLAUDE_CODE_OAUTH_TOKEN", `${KEY_A},${KEY_B}`);
    const result = await check(id, "claude-secret");
    const wire = JSON.stringify(result) + formatProfileCheckFailures(result);
    expect(wire).not.toContain(KEY_A);
    expect(wire).not.toContain(KEY_B);
    expect(wire).not.toContain("secret-material");
  });
});
