import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { McpConnection } from "../mcp";
import type { Scenario, ScenarioContext } from "../run";
import {
  callTool,
  expectToolError,
  expectToolOk,
  registerLead,
  registerWorker,
  retireAgent,
  withMcp,
} from "./core-helpers";

const GHOST = "00000000-0000-4000-8000-00000000dead";

function soul(marker: string, ctx: ScenarioContext): string {
  return `${marker} ${ctx.nonce}\n${"s".repeat(220)}`;
}

/** Swarm overview tools any agent can call. */
async function overviewTools(ctx: ScenarioContext, conn: McpConnection, workerId: string) {
  // get-swarm: slim by default, identity markdown only with includeFull.
  let outcome = await expectToolOk(conn, "get-swarm");
  expect(
    /^Found \d+ agent\(s\) in the swarm/.test(outcome.message),
    `get-swarm: ${outcome.message}`,
  );
  expect(outcome.text.includes(workerId), "get-swarm text channel omits the worker id");
  let agents = asRecords(outcome.data, "agents");
  const slim = agents.find((agent) => agent.id === workerId);
  expect(slim !== undefined, "get-swarm omitted the calling agent");
  expect(outcome.data.yourAgentId === workerId, "get-swarm yourAgentId is wrong");
  expect(!("soulMd" in slim) && !("claudeMd" in slim), "Slim get-swarm carries identity markdown");

  // list-model-profiles: seeded tier profiles, filterable by harness.
  outcome = await expectToolOk(conn, "list-model-profiles");
  let profiles = asRecords(outcome.data, "profiles");
  expect(
    profiles.some((profile) => profile.name === "claude-smart" && profile.harness === "claude"),
    "list-model-profiles lacks the seeded claude-smart profile",
  );
  expect(
    /^\d+ model profile\(s\)\.$/.test(outcome.message),
    `Unexpected message ${outcome.message}`,
  );
  outcome = await expectToolOk(conn, "list-model-profiles", { harness: "codex" });
  profiles = asRecords(outcome.data, "profiles");
  expect(
    profiles.length > 0 && profiles.every((profile) => profile.harness === "codex"),
    "The codex filter returned another harness",
  );
  expect(outcome.message.endsWith("for codex."), `Filtered message ${outcome.message}`);

  // get-metrics mirrors GET /api/metrics.
  outcome = await expectToolOk(conn, "get-metrics");
  const http = await ctx.api("GET", "/api/metrics");
  expectStatus(http, [200], "GET /api/metrics");
  const counts = asRecord(http.json);
  expect(
    asRecord(outcome.data.agents).total === asRecord(counts.agents).total &&
      asRecord(outcome.data.skills).total === asRecord(counts.skills).total &&
      asRecord(outcome.data.workflows).total === asRecord(counts.workflows).total,
    "get-metrics disagrees with GET /api/metrics",
  );
  expect(outcome.message.startsWith("Swarm metrics:"), `get-metrics message ${outcome.message}`);
  for (const group of ["tasks", "agents", "workflows", "pages", "sessions", "skills"]) {
    expect(typeof outcome.data[group] === "object", `get-metrics lacks ${group}`);
  }

  // join-swarm needs an unregistered X-Agent-ID, and /mcp refuses unknown agents at connect
  // time. A registered caller can only reach the duplicate guard.
  await expectToolError(conn, "join-swarm", { name: `core-join-${ctx.nonce}` }, "already exists");
  agents = asRecords((await expectToolOk(conn, "get-swarm", { includeFull: true })).data, "agents");
  expect(agents.length > 0, "includeFull get-swarm returned no agents");
}

/** Profile editing and the version tools that read it back. */
async function profileTools(
  ctx: ScenarioContext,
  worker: McpConnection,
  workerId: string,
  lead: McpConnection,
  leadId: string,
) {
  const first = soul("first soul", ctx);
  const second = soul("second soul", ctx);
  let outcome = await expectToolOk(worker, "update-profile", {
    description: `mcp profile ${ctx.nonce}`,
    role: "mcp-role",
    capabilities: ["x", "y"],
    soulMd: first,
    setupScript: "echo core-tools-setup",
    avatar: { type: "lucide", icon: "bot" },
  });
  expect(outcome.message.startsWith("Updated own profile"), `update-profile: ${outcome.message}`);
  expect(asRecord(outcome.data.agent).role === "mcp-role", "update-profile agent payload is stale");
  await expectToolOk(worker, "update-profile", { soulMd: second });

  let read = await ctx.api("GET", `/api/agents/${workerId}`);
  expectStatus(read, [200], "read the profile back");
  expect(asRecord(read.json).soulMd === second, "update-profile did not persist soulMd");
  expect(asRecord(read.json).setupScript === "echo core-tools-setup", "setupScript not persisted");

  // Refusals.
  await expectToolError(worker, "update-profile", {}, "At least one field");
  await expectToolError(worker, "update-profile", { soulMd: "too short" }, "200");
  await expectToolError(
    worker,
    "update-profile",
    { setupScript: "if then fi (" },
    "Invalid setupScript",
  );
  await expectToolError(
    worker,
    "update-profile",
    { agentId: leadId, description: "hijack" },
    "Only lead agents",
  );

  // context-history: newest first, filters, permission.
  outcome = await expectToolOk(worker, "context-history", { field: "soulMd" });
  const versions = asRecords(outcome.data, "versions");
  expect(
    versions.length === 2 && versions[0]?.version === 2 && versions[1]?.version === 1,
    `Expected soulMd v2 then v1, got ${JSON.stringify(versions.map((row) => row.version))}`,
  );
  expect(
    versions.every((row) => row.changeSource === "self_edit" && row.changedByAgentId === workerId),
    "Version metadata lost the self_edit attribution",
  );
  outcome = await expectToolOk(worker, "context-history", { field: "soulMd", limit: 1 });
  expect(
    asRecords(outcome.data, "versions").length === 1,
    "limit:1 returned more than one version",
  );
  outcome = await expectToolOk(worker, "context-history", { field: "claudeMd" });
  expect(asRecords(outcome.data, "versions").length === 0, "A never-set field has versions");
  await expectToolError(
    worker,
    "context-history",
    { agentId: leadId },
    "Only the lead can view other agents",
  );
  await expectToolError(worker, "context-history", { agentId: GHOST }, "Agent not found");

  // context-diff: unified diff of a version against its predecessor.
  const newest = String(versions[0]?.id);
  const oldest = String(versions[1]?.id);
  outcome = await expectToolOk(worker, "context-diff", { versionId: newest });
  expect(
    outcome.data.field === "soulMd" &&
      outcome.data.fromVersion === 1 &&
      outcome.data.toVersion === 2,
    `Unexpected diff header ${JSON.stringify(outcome.data)}`,
  );
  const diff = String(outcome.data.diff);
  expect(
    diff.includes(`-first soul ${ctx.nonce}`) && diff.includes(`+second soul ${ctx.nonce}`),
    `Diff does not show the soul change:\n${diff}`,
  );
  outcome = await expectToolOk(worker, "context-diff", { versionId: oldest });
  expect(
    String(outcome.data.diff).includes(`+first soul ${ctx.nonce}`),
    "v1 diff is not all additions",
  );
  outcome = await expectToolOk(worker, "context-diff", {
    versionId: newest,
    compareToVersionId: oldest,
  });
  expect(String(outcome.data.diff).includes("+second soul"), "Explicit comparison lost the change");
  await expectToolError(worker, "context-diff", { versionId: GHOST }, "not found");
  await expectToolError(
    worker,
    "context-diff",
    { versionId: newest, compareToVersionId: GHOST },
    "not found",
  );

  // The lead edits and reads another agent's profile.
  outcome = await expectToolOk(lead, "update-profile", {
    agentId: workerId,
    soulMd: soul("coached soul", ctx),
  });
  expect(outcome.message.includes("Updated"), `lead update-profile: ${outcome.message}`);
  await expectToolError(lead, "update-profile", { agentId: GHOST, description: "x" }, "not found");
  outcome = await expectToolOk(lead, "context-history", { agentId: workerId, field: "soulMd" });
  const coached = asRecords(outcome.data, "versions")[0];
  expect(
    coached?.version === 3 &&
      coached.changeSource === "lead_coaching" &&
      coached.changedByAgentId === leadId,
    `Lead coaching version is wrong: ${JSON.stringify(coached)}`,
  );
  outcome = await expectToolOk(lead, "context-diff", { versionId: String(coached?.id) });
  expect(String(outcome.data.diff).includes("+coached soul"), "Lead diff of a worker's version");
  read = await ctx.api("GET", `/api/agents/${workerId}`);
  expect(asRecord(read.json).soulMd === soul("coached soul", ctx), "Coached soul was not stored");
}

/** The user registry tools: manage-user (lead only), resolve-user (everyone). */
async function userTools(
  ctx: ScenarioContext,
  worker: McpConnection,
  lead: McpConnection,
): Promise<void> {
  const email = `core-${ctx.nonce}@example.com`;
  const slackId = `UCORE${ctx.nonce}`;
  await expectToolError(worker, "manage-user", { action: "list" }, "Only the lead agent");

  let outcome = await expectToolOk(lead, "manage-user", {
    action: "create",
    name: `Core Person ${ctx.nonce}`,
    email,
    role: "founder",
    timezone: "Europe/Madrid",
    identities: [{ kind: "slack", externalId: slackId }],
    comms: { tone: "terse" },
  });
  const created = asRecord(outcome.data.user);
  const userId = String(created.id);
  expect(
    created.email === email && asRecord(asRecord(created.metadata).comms).tone === "terse",
    "manage-user create lost fields",
  );
  const http = await ctx.api("GET", `/api/users/${userId}`);
  expectStatus(http, [200], "the created user is readable over HTTP");

  outcome = await expectToolOk(lead, "manage-user", {
    action: "update",
    userId,
    role: "cto",
    identities: [
      { kind: "slack", externalId: slackId },
      { kind: "github", externalId: `octo-${ctx.nonce}` },
    ],
    comms: { language: "es", tone: null },
  });
  const updated = asRecord(outcome.data.user);
  const comms = asRecord(asRecord(updated.metadata).comms);
  expect(
    updated.role === "cto" && comms.language === "es" && !("tone" in comms),
    `manage-user update merged comms wrongly: ${JSON.stringify(updated.metadata)}`,
  );
  outcome = await expectToolOk(lead, "manage-user", { action: "get", userId });
  expect(asRecord(outcome.data.user).role === "cto", "manage-user get returned a stale user");
  outcome = await expectToolOk(lead, "manage-user", { action: "list" });
  expect(
    asRecords(outcome.data, "users").some((user) => user.id === userId),
    "manage-user list omitted the created user",
  );
  await expectToolError(lead, "manage-user", { action: "get", userId: GHOST }, "not found");
  await expectToolError(lead, "manage-user", { action: "create" }, "name is required");
  await expectToolError(lead, "manage-user", { action: "update" }, "userId is required");

  // resolve-user: every lookup key finds the same person.
  for (const [label, args] of [
    ["identity", { kind: "github", externalId: `octo-${ctx.nonce}` }],
    ["email", { email }],
    ["userId", { userId }],
    ["name", { name: `Core Person ${ctx.nonce}` }],
  ] as const) {
    outcome = await expectToolOk(worker, "resolve-user", args);
    expect(outcome.data.id === userId, `resolve-user by ${label} found ${String(outcome.data.id)}`);
    const ids = asRecords(outcome.data, "externalIds").map(
      (row) => `${row.kind}:${row.externalId}`,
    );
    expect(
      ids.includes(`slack:${slackId}`) && ids.includes(`github:octo-${ctx.nonce}`),
      `resolve-user by ${label} lost identities: ${ids.join(",")}`,
    );
  }
  outcome = await expectToolOk(worker, "resolve-user", {
    kind: "slack",
    externalId: `NOPE${ctx.nonce}`,
  });
  expect(outcome.data.status === "unknown", "A miss should answer {status:'unknown'}");

  // Ambiguous name: two people share a first token.
  const prefix = `Ambi${ctx.nonce}`;
  for (const suffix of ["Alpha", "Beta"]) {
    await expectToolOk(lead, "manage-user", { action: "create", name: `${prefix} ${suffix}` });
  }
  outcome = await expectToolOk(worker, "resolve-user", { name: prefix });
  expect(
    outcome.data.status === "ambiguous" && asRecords(outcome.data, "candidates").length === 2,
    `Expected two ambiguous candidates, got ${JSON.stringify(outcome.data)}`,
  );
  const bad = await callTool(worker, "resolve-user", {});
  expect(bad.isError, "resolve-user accepted an empty lookup");

  // delete removes the user.
  outcome = await expectToolOk(lead, "manage-user", { action: "delete", userId });
  expect(outcome.message.length > 0, "manage-user delete returned no message");
  await expectToolError(lead, "manage-user", { action: "get", userId }, "not found");
  outcome = await expectToolOk(worker, "resolve-user", { userId });
  expect(outcome.data.status === "unknown", "A deleted user still resolves by id");
}

/** The lead pushes a learning into a worker's memory. */
async function learningTool(
  ctx: ScenarioContext,
  worker: McpConnection,
  workerId: string,
  lead: McpConnection,
): Promise<void> {
  const learning = `Prefer small commits ${ctx.nonce}`;
  const outcome = await expectToolOk(lead, "inject-learning", {
    agentId: workerId,
    learning,
    category: "best-practice",
  });
  const memoryId = String(outcome.data.memoryId);
  expect(outcome.message.includes("best-practice"), `inject-learning: ${outcome.message}`);
  const row = ctx.db.get<{ agentId: string; scope: string; content: string }>(
    "SELECT agentId, scope, content FROM agent_memory WHERE id = ?",
    [memoryId],
  );
  expect(
    row?.agentId === workerId && row.scope === "swarm" && row.content.includes(learning),
    `Injected memory row is wrong: ${JSON.stringify(row)}`,
  );
  await expectToolError(
    worker,
    "inject-learning",
    { agentId: workerId, learning: "self", category: "preference" },
    "Only the lead",
  );
  await expectToolError(
    lead,
    "inject-learning",
    { agentId: GHOST, learning: "x", category: "preference" },
    "not found",
  );
  const invalid = await callTool(lead, "inject-learning", {
    agentId: workerId,
    learning: "x",
    category: "not-a-category",
  });
  expect(invalid.isError, "inject-learning accepted an unknown category");
}

export const coreAgentTools: Scenario = {
  name: "core-agent-tools",
  order: 210,
  async run(ctx) {
    const workerId = await registerWorker(ctx, "tools");
    const leadId = await registerLead(ctx, "tools");
    try {
      await withMcp(ctx, workerId, async (worker) => {
        await withMcp(ctx, leadId, async (lead) => {
          await overviewTools(ctx, worker, workerId);
          await profileTools(ctx, worker, workerId, lead, leadId);
          await userTools(ctx, worker, lead);
          await learningTool(ctx, worker, workerId, lead);
        });
      });
    } finally {
      await retireAgent(ctx, leadId);
    }
  },
};
