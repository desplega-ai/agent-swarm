/**
 * RBAC slice-1 wire-level e2e (DES-445). Port of the live QA in
 * thoughts/taras/qa/2026-07-07-des-445-rbac-slice1.md, steps 1–2.
 *
 * One REAL server subprocess (scratch DB, real handleCore auth, real MCP
 * Streamable-HTTP handshake); every gate below is exercised over the wire and
 * the test finishes by asserting the permission_audit trail matches the
 * issued `can()` decisions 1:1 (multiset over principal/verb/decision/
 * reason/source).
 *
 * This is the parity net for increment 3: when the role engine replaces
 * LEGACY_POLICY behind can(), this suite must pass unchanged.
 *
 * Lifecycle surfaces (boot-race, SIGTERM drain, kill-switch, retention) live
 * in rbac-lifecycle-e2e.test.ts, which is env-gated and NOT part of the
 * default `bun test` run.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import {
  api,
  LEAD,
  makeScratchDir,
  mcpCall,
  mcpInit,
  readAuditRows,
  registerAgent,
  removeScratchDir,
  type SwarmServer,
  spawnSwarmServer,
  WORKER_A,
  WORKER_B,
  waitForAuditCount,
} from "./rbac-e2e-helpers";

setDefaultTimeout(120_000);

let dir: string;
let server: SwarmServer;
let base: string;
let sidLead: string;
let sidA: string;
let sidB: string;
let userToken: string;
let userId: string;

/**
 * Every gated call made below pushes its expected audit row here; the final
 * test compares this multiset against the actual permission_audit table.
 * Calls that must NOT be audited (structural guards, ungated scopes, auth-layer
 * rejections) simply don't push.
 */
const expected: Array<{
  principalType: string;
  principalId: string | null;
  verb: string;
  decision: "allow" | "deny";
  reason: string | null;
  source: "mcp" | "http";
}> = [];

function expectRow(
  principal: { type: "agent" | "user" | "operator"; id: string | null },
  verb: string,
  decision: "allow" | "deny",
  reason: string | null,
  source: "mcp" | "http",
): void {
  expected.push({
    principalType: principal.type,
    principalId: principal.id,
    verb,
    decision,
    reason,
    source,
  });
}

const DENY = {
  leadOnly: "requires lead agent",
  leadOrTaskCreator: "requires lead agent or task creator",
  leadOrResourceOwner: "requires lead agent or resource owner",
  leadOrOwnNamespace: "requires lead agent or your own task:agent: namespace",
  memoryOwnerOrLeadSwarm: "requires memory owner, or lead agent for swarm-scoped memories",
} as const;

const skillMd = (name: string, description: string) =>
  `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\nbody`;

beforeAll(async () => {
  dir = await makeScratchDir();
  server = await spawnSwarmServer({
    dbPath: join(dir, "wire.sqlite"),
    logPath: join(dir, "server.log"),
  });
  base = server.base;

  await registerAgent(base, LEAD, "e2e-lead", true);
  await registerAgent(base, WORKER_A, "e2e-worker-a", false);
  await registerAgent(base, WORKER_B, "e2e-worker-b", false);

  sidLead = await mcpInit(base, LEAD);
  sidA = await mcpInit(base, WORKER_A);
  sidB = await mcpInit(base, WORKER_B);

  const user = await api(base, "POST", "/api/users", {
    body: { name: "e2e-user", email: "rbac-e2e@example.com" },
  });
  userId = user.body.user.id;
  const minted = await api(base, "POST", `/api/users/${userId}/mcp-tokens`, { body: {} });
  userToken = minted.body.plaintext;
  expect(userToken).toStartWith("aswt_");
});

afterAll(async () => {
  if (server) await server.stop();
  if (dir) await removeScratchDir(dir);
});

describe("MCP gate matrix", () => {
  test("config: set/delete lead-gated; includeSecrets masks for non-lead (DES-445 follow-up)", async () => {
    // set-config (non-credential key): worker denied, lead allowed.
    const setWorker = await mcpCall(base, WORKER_A, sidA, "set-config", {
      scope: "global",
      key: "E2E_CONFIG_KEY",
      value: "v1",
    });
    expect(setWorker.structuredContent.success).toBe(false);
    expect(setWorker.structuredContent.message).toContain("requires the lead agent");
    expectRow({ type: "agent", id: WORKER_A }, "config.write.any", "deny", DENY.leadOnly, "mcp");

    const setLead = await mcpCall(base, LEAD, sidLead, "set-config", {
      scope: "global",
      key: "E2E_CONFIG_KEY",
      value: "v1",
    });
    expect(setLead.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "config.write.any", "allow", null, "mcp");
    const configId = setLead.structuredContent.config.id as string;

    // delete-config: worker denied, lead allowed.
    const delWorker = await mcpCall(base, WORKER_A, sidA, "delete-config", { id: configId });
    expect(delWorker.structuredContent.success).toBe(false);
    expect(delWorker.structuredContent.message).toContain("requires the lead agent");
    expectRow({ type: "agent", id: WORKER_A }, "config.delete.any", "deny", DENY.leadOnly, "mcp");

    const delLead = await mcpCall(base, LEAD, sidLead, "delete-config", { id: configId });
    expect(delLead.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "config.delete.any", "allow", null, "mcp");

    // includeSecrets read: lead sees plaintext, worker is force-masked + noted.
    const setSecret = await mcpCall(base, LEAD, sidLead, "set-config", {
      scope: "global",
      key: "E2E_SECRET",
      value: "sensitive",
      isSecret: true,
    });
    expect(setSecret.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "config.write.any", "allow", null, "mcp");

    const readWorker = await mcpCall(base, WORKER_A, sidA, "get-config", {
      key: "E2E_SECRET",
      includeSecrets: true,
    });
    expect(readWorker.structuredContent.success).toBe(true);
    expect(readWorker.structuredContent.message).toContain("masked");
    const wSecret = readWorker.structuredContent.configs.find(
      (c: { key: string; value: string }) => c.key === "E2E_SECRET",
    );
    expect(wSecret?.value).not.toBe("sensitive");
    expectRow({ type: "agent", id: WORKER_A }, "config.read.secrets", "deny", DENY.leadOnly, "mcp");

    const readLead = await mcpCall(base, LEAD, sidLead, "get-config", {
      key: "E2E_SECRET",
      includeSecrets: true,
    });
    expect(readLead.structuredContent.success).toBe(true);
    const lSecret = readLead.structuredContent.configs.find(
      (c: { key: string; value: string }) => c.key === "E2E_SECRET",
    );
    expect(lSecret?.value).toBe("sensitive");
    expectRow({ type: "agent", id: LEAD }, "config.read.secrets", "allow", null, "mcp");
  });

  test("config HTTP: operator (swarm key) still writes/deletes — blast-radius guard", async () => {
    // The HTTP config gate short-circuits operator/user auth as allowed, so the
    // dashboard / codex-oauth / devin flows (all operator over the swarm key)
    // keep working. Operator short-circuits BEFORE can() → no audit row.
    const put = await api(base, "PUT", "/api/config", {
      agentId: LEAD,
      body: { scope: "global", key: "E2E_HTTP_KEY", value: "h1" },
    });
    expect(put.status).toBe(200);
    const id = put.body.id as string;

    const del = await api(base, "DELETE", `/api/config/${id}`, { agentId: WORKER_A });
    expect(del.status).toBe(200);
  });

  test("skill-create scope=swarm is lead-only; scope=agent is ungated", async () => {
    const args = { content: skillMd("e2e-skill", "swarm skill"), scope: "swarm" };

    const denied = await mcpCall(base, WORKER_A, sidA, "skill-create", args);
    expect(denied.structuredContent.success).toBe(false);
    expect(denied.structuredContent.message).toContain("Only lead agents");
    expectRow({ type: "agent", id: WORKER_A }, "skill.create.swarm", "deny", DENY.leadOnly, "mcp");

    const allowed = await mcpCall(base, LEAD, sidLead, "skill-create", args);
    expect(allowed.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "skill.create.swarm", "allow", null, "mcp");

    // agent scope never reaches can() — no audit row expected.
    const own = await mcpCall(base, WORKER_A, sidA, "skill-create", {
      content: skillMd("e2e-skill-wa", "worker A own skill"),
      scope: "agent",
    });
    expect(own.structuredContent.success).toBe(true);
    expect(own.structuredContent.skill.ownerAgentId).toBe(WORKER_A);
  });

  test("skill-update allows owner and lead, denies foreign worker", async () => {
    const own = await mcpCall(base, WORKER_A, sidA, "skill-create", {
      content: skillMd("e2e-skill-upd", "update target"),
      scope: "agent",
    });
    const skillId = own.structuredContent.skill.id;

    const byOwner = await mcpCall(base, WORKER_A, sidA, "skill-update", {
      skillId,
      content: skillMd("e2e-skill-upd", "updated by owner"),
    });
    expect(byOwner.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: WORKER_A }, "skill.update.any", "allow", null, "mcp");

    const byForeign = await mcpCall(base, WORKER_B, sidB, "skill-update", {
      skillId,
      content: skillMd("e2e-skill-upd", "hijack attempt"),
    });
    expect(byForeign.structuredContent.success).toBe(false);
    expect(JSON.stringify(byForeign.content)).toContain("owning agent or lead");
    expectRow(
      { type: "agent", id: WORKER_B },
      "skill.update.any",
      "deny",
      DENY.leadOrResourceOwner,
      "mcp",
    );

    const byLead = await mcpCall(base, LEAD, sidLead, "skill-update", {
      skillId,
      content: skillMd("e2e-skill-upd", "updated by lead"),
    });
    expect(byLead.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "skill.update.any", "allow", null, "mcp");
  });

  test("memory-delete: owner always; lead only for swarm scope", async () => {
    const seed = async (name: string, scope: "agent" | "swarm") => {
      const res = await api(base, "POST", "/api/memory/index", {
        agentId: WORKER_A,
        body: {
          agentId: WORKER_A,
          content: `e2e memory ${name}`,
          name,
          scope,
          source: "manual",
        },
      });
      expect(res.status).toBe(202);
      return res.body.memoryIds[0] as string;
    };
    const m1 = await seed("e2e-mem-1", "agent");
    const m2 = await seed("e2e-mem-2", "swarm");
    const m3 = await seed("e2e-mem-3", "agent");

    // Indexing is async (202) — poll the DB until all three rows exist.
    const deadline = Date.now() + 20_000;
    const present = () => {
      const db = new Database(server.dbPath, { readonly: true });
      try {
        const row = db
          .prepare("SELECT count(*) AS n FROM agent_memory WHERE id IN (?, ?, ?)")
          .get(m1, m2, m3) as { n: number };
        return row.n;
      } finally {
        db.close();
      }
    };
    while (present() < 3 && Date.now() < deadline) await Bun.sleep(250);
    expect(present()).toBe(3);

    const byForeign = await mcpCall(base, WORKER_B, sidB, "memory-delete", { memoryId: m1 });
    expect(byForeign.structuredContent.success).toBe(false);
    expectRow(
      { type: "agent", id: WORKER_B },
      "memory.delete.any",
      "deny",
      DENY.memoryOwnerOrLeadSwarm,
      "mcp",
    );

    const byOwner = await mcpCall(base, WORKER_A, sidA, "memory-delete", { memoryId: m1 });
    expect(byOwner.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: WORKER_A }, "memory.delete.any", "allow", null, "mcp");

    // Lead is NOT owner and m3 is agent-scoped → deny.
    const leadOnAgentScoped = await mcpCall(base, LEAD, sidLead, "memory-delete", {
      memoryId: m3,
    });
    expect(leadOnAgentScoped.structuredContent.success).toBe(false);
    expectRow(
      { type: "agent", id: LEAD },
      "memory.delete.any",
      "deny",
      DENY.memoryOwnerOrLeadSwarm,
      "mcp",
    );

    const leadOnSwarmScoped = await mcpCall(base, LEAD, sidLead, "memory-delete", {
      memoryId: m2,
    });
    expect(leadOnSwarmScoped.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "memory.delete.any", "allow", null, "mcp");
  });

  test("kv-set: own namespace and lead allowed, foreign denied, task:page structural", async () => {
    const ownNs = await mcpCall(base, WORKER_A, sidA, "kv-set", {
      key: "e2e-own",
      value: "v",
      namespace: `task:agent:${WORKER_A}`,
    });
    expect(ownNs.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: WORKER_A }, "kv.write.any", "allow", null, "mcp");

    const foreignNs = await mcpCall(base, WORKER_A, sidA, "kv-set", {
      key: "e2e-foreign",
      value: "v",
      namespace: `task:agent:${WORKER_B}`,
    });
    expect(foreignNs.structuredContent.success).toBe(false);
    expect(foreignNs.structuredContent.message).toContain("require lead");
    expectRow(
      { type: "agent", id: WORKER_A },
      "kv.write.any",
      "deny",
      DENY.leadOrOwnNamespace,
      "mcp",
    );

    const leadForeign = await mcpCall(base, LEAD, sidLead, "kv-set", {
      key: "e2e-lead",
      value: "v",
      namespace: `task:agent:${WORKER_A}`,
    });
    expect(leadForeign.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "kv.write.any", "allow", null, "mcp");

    // Structural guard, not a can() verb — deny message, NO audit row.
    const pageNs = await mcpCall(base, LEAD, sidLead, "kv-set", {
      key: "e2e-page",
      value: "v",
      namespace: "task:page:e2e-page",
    });
    expect(pageNs.structuredContent.success).toBe(false);
    expect(pageNs.structuredContent.message).toContain("page-proxy request");
  });

  test("cancel-task: creator and lead allowed, other worker denied", async () => {
    const create = async () => {
      const res = await api(base, "POST", "/api/tasks", {
        agentId: WORKER_A, // X-Agent-ID of the create request records creatorAgentId
        body: { task: "e2e cancel target", agentId: WORKER_B },
      });
      expect([200, 201]).toContain(res.status);
      return (res.body.id ?? res.body.task?.id) as string;
    };
    const t1 = await create();
    const t2 = await create();
    const t3 = await create();

    const byOther = await mcpCall(base, WORKER_B, sidB, "cancel-task", {
      taskId: t2,
      reason: "e2e deny",
    });
    expect(byOther.structuredContent.success).toBe(false);
    expect(byOther.structuredContent.message).toContain("lead or task creator");
    expectRow(
      { type: "agent", id: WORKER_B },
      "task.cancel.any",
      "deny",
      DENY.leadOrTaskCreator,
      "mcp",
    );

    const byCreator = await mcpCall(base, WORKER_A, sidA, "cancel-task", {
      taskId: t1,
      reason: "e2e creator",
    });
    expect(byCreator.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: WORKER_A }, "task.cancel.any", "allow", null, "mcp");

    const byLead = await mcpCall(base, LEAD, sidLead, "cancel-task", {
      taskId: t3,
      reason: "e2e lead",
    });
    expect(byLead.structuredContent.success).toBe(true);
    expectRow({ type: "agent", id: LEAD }, "task.cancel.any", "allow", null, "mcp");
  });
});

describe("HTTP gates", () => {
  test("scripts global upsert/delete are lead-only; agent scope is ungated", async () => {
    const source = "export default async function main() { return 1; }";

    const upsertWorker = await api(base, "POST", "/api/scripts/upsert", {
      agentId: WORKER_A,
      body: { name: "e2e-script", source, scope: "global" },
    });
    expect(upsertWorker.status).toBe(403);
    expect(upsertWorker.body.error).toContain("Global write requires lead agent");
    expectRow(
      { type: "agent", id: WORKER_A },
      "script.global.write",
      "deny",
      DENY.leadOnly,
      "http",
    );

    const upsertLead = await api(base, "POST", "/api/scripts/upsert", {
      agentId: LEAD,
      body: { name: "e2e-script", source, scope: "global" },
    });
    expect(upsertLead.status).toBe(200);
    expectRow({ type: "agent", id: LEAD }, "script.global.write", "allow", null, "http");

    // agent scope never reaches can() — no audit row.
    const upsertAgentScope = await api(base, "POST", "/api/scripts/upsert", {
      agentId: WORKER_A,
      body: { name: "e2e-script-agent", source, scope: "agent" },
    });
    expect(upsertAgentScope.status).toBe(200);

    const deleteWorker = await api(base, "DELETE", "/api/scripts/e2e-script?scope=global", {
      agentId: WORKER_A,
    });
    expect(deleteWorker.status).toBe(403);
    expect(deleteWorker.body.error).toContain("Global delete requires lead agent");
    expectRow(
      { type: "agent", id: WORKER_A },
      "script.global.delete",
      "deny",
      DENY.leadOnly,
      "http",
    );

    const deleteLead = await api(base, "DELETE", "/api/scripts/e2e-script?scope=global", {
      agentId: LEAD,
    });
    expect(deleteLead.status).toBe(200);
    expectRow({ type: "agent", id: LEAD }, "script.global.delete", "allow", null, "http");

    const deleteAgentScope = await api(
      base,
      "DELETE",
      "/api/scripts/e2e-script-agent?scope=agent",
      {
        agentId: WORKER_A,
      },
    );
    expect(deleteAgentScope.status).toBe(200);
  });

  test("kv HTTP: blank-agent regression stays denied, own/foreign namespaces gate", async () => {
    // The blank-agent regression (a0c4ec74): the literal `task:agent:`
    // namespace with a missing or empty X-Agent-ID must be denied. A missing
    // header dies before can() (no caller identity → no audit row); an
    // empty-string header reaches can() and the policy's blank-agent guard
    // (`principal.agentId !== ""`) denies it, auditing principalId="".
    const noHeader = await api(base, "PUT", "/api/kv/_/task:agent:/e2e-blank", {
      body: { value: "sneaky" },
    });
    expect(noHeader.status).toBe(403);
    expect(noHeader.body.error).toContain("require lead");

    const emptyHeader = await api(base, "PUT", "/api/kv/_/task:agent:/e2e-blank", {
      agentId: "",
      body: { value: "sneaky" },
    });
    expect(emptyHeader.status).toBe(403);
    expectRow({ type: "agent", id: "" }, "kv.write.any", "deny", DENY.leadOrOwnNamespace, "http");

    const own = await api(base, "PUT", `/api/kv/_/task:agent:${WORKER_A}/e2e-k`, {
      agentId: WORKER_A,
      body: { value: "ok" },
    });
    expect(own.status).toBe(200);
    expectRow({ type: "agent", id: WORKER_A }, "kv.write.any", "allow", null, "http");

    const foreign = await api(base, "PUT", `/api/kv/_/task:agent:${WORKER_B}/e2e-k`, {
      agentId: WORKER_A,
      body: { value: "nope" },
    });
    expect(foreign.status).toBe(403);
    expectRow(
      { type: "agent", id: WORKER_A },
      "kv.write.any",
      "deny",
      DENY.leadOrOwnNamespace,
      "http",
    );

    // task:page:* without X-Page-Id → page-proxy structural guard, no audit row.
    const pageNs = await api(base, "PUT", "/api/kv/_/task:page:e2e-page/e2e-k", {
      agentId: LEAD,
      body: { value: "nope" },
    });
    expect(pageNs.status).toBe(403);
    expect(pageNs.body.error).toContain("page-proxy request");
  });

  test("fs mutate: operator and user allowed; invalid bearer dies at auth layer", async () => {
    const created = await api(base, "POST", "/api/tasks", {
      agentId: WORKER_A,
      body: { task: "e2e fs target", agentId: WORKER_B },
    });
    const taskId = (created.body.id ?? created.body.task?.id) as string;

    // Operator bearer short-circuits BEFORE agent identity — a non-owner
    // X-Agent-ID is still allowed (parity with pre-RBAC canMutateTask).
    const asOperator = await api(base, "POST", `/api/fs/tasks/${taskId}/files?name=op.txt`, {
      agentId: LEAD,
      rawBody: "operator upload",
    });
    expect(asOperator.status).toBe(201);
    expectRow({ type: "operator", id: null }, "task.fs.mutate", "allow", null, "http");

    const asUser = await api(base, "POST", `/api/fs/tasks/${taskId}/files?name=user.txt`, {
      bearer: userToken,
      rawBody: "user upload",
    });
    expect(asUser.status).toBe(201);
    expectRow({ type: "user", id: userId }, "task.fs.mutate", "allow", null, "http");

    // An unknown bearer never reaches canMutateTask — handleCore 401s it, so
    // the agent-branch deny is not constructible over the wire (QA obs. A).
    const badBearer = await api(base, "POST", `/api/fs/tasks/${taskId}/files?name=bad.txt`, {
      bearer: "not-a-real-key",
      agentId: WORKER_B,
      rawBody: "x",
    });
    expect(badBearer.status).toBe(401);
  });
});

describe("audit trail fidelity", () => {
  test("permission_audit matches the issued decisions 1:1", async () => {
    const n = await waitForAuditCount(server.dbPath, expected.length);
    const rows = readAuditRows(server.dbPath);
    const key = (r: {
      principalType: string;
      principalId: string | null;
      verb: string;
      decision: string;
      reason: string | null;
      source: string;
    }) => `${r.principalType}|${r.principalId}|${r.verb}|${r.decision}|${r.reason}|${r.source}`;

    const actualSorted = rows.map(key).sort();
    const expectedSorted = expected.map(key).sort();
    expect(actualSorted).toEqual(expectedSorted);
    expect(n).toBe(expected.length);
  });
});
