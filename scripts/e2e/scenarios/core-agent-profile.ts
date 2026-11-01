import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { cancelQuietly, createAssignedTask, registerWorker, UUID } from "./core-helpers";

type SwarmConfigRow = { value: string };

function configValue(ctx: ScenarioContext, agentId: string, key: string): string | null {
  return (
    ctx.db.get<SwarmConfigRow>(
      "SELECT value FROM swarm_config WHERE scope = 'agent' AND scopeId = ? AND key = ?",
      [agentId, key],
    )?.value ?? null
  );
}

async function readAgent(ctx: ScenarioContext, agentId: string): Promise<Record<string, unknown>> {
  const response = await ctx.api("GET", `/api/agents/${agentId}`);
  expectStatus(response, [200], `read agent ${agentId}`);
  return asRecord(response.json);
}

/** Identity, naming, profile versions, harness and runtime settings of one worker. */
async function identityAndProfile(ctx: ScenarioContext): Promise<string> {
  const agentId = await registerWorker(ctx, "profile", { maxTasks: 2 });
  const rival = await registerWorker(ctx, "profile-rival");
  const baseName = String((await readAgent(ctx, agentId)).name);

  // PUT /api/agents/{id}/name: rename, persist, reject duplicates and bad input.
  const renamed = `core-renamed-${ctx.nonce}`;
  let response = await ctx.api("PUT", `/api/agents/${agentId}/name`, {
    body: { name: ` ${renamed} ` },
  });
  expectStatus(response, [200], "rename agent");
  expect(asRecord(response.json).name === renamed, "Rename did not trim and apply the new name");
  expect(
    ctx.db.get<{ name: string }>("SELECT name FROM agents WHERE id = ?", [agentId])?.name ===
      renamed,
    "agents row does not carry the new name",
  );
  response = await ctx.api("PUT", `/api/agents/${rival}/name`, { body: { name: renamed } });
  expectStatus(response, [409], "rename to an existing name");
  expect(String(asRecord(response.json).error).includes("already exists"), "409 lacks the reason");
  expectStatus(
    await ctx.api("PUT", `/api/agents/${agentId}/name`, { body: { name: "" } }),
    [400],
    "empty name",
  );
  expectStatus(
    await ctx.api("PUT", "/api/agents/00000000-0000-4000-8000-00000000dead/name", {
      body: { name: `ghost-${ctx.nonce}` },
    }),
    [404],
    "rename unknown agent",
  );
  response = await ctx.api("PUT", `/api/agents/${agentId}/name`, { body: { name: baseName } });
  expectStatus(response, [200], "restore the original name");

  // PUT /api/agents/{id}/activity: 204 and the heartbeat timestamp moves.
  expectStatus(await ctx.api("PUT", `/api/agents/${agentId}/activity`), [204], "touch activity");
  expect(
    typeof (await readAgent(ctx, agentId)).lastActivityAt === "string",
    "Activity touch did not set lastActivityAt",
  );

  // PUT /api/agents/{id}/profile: fields, versioning, guards.
  const soulV1 = `Soul one ${ctx.nonce} `.padEnd(300, "s");
  const soulV2 = `Soul two ${ctx.nonce} `.padEnd(320, "t");
  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
    body: {
      role: "qa-engineer",
      description: `Profile description ${ctx.nonce}`,
      capabilities: ["testing", "triage"],
      avatar: { type: "lucide", icon: "bot", color: "#336699" },
      slackIcon: { type: "emoji", emoji: ":owl:" },
      soulMd: soulV1,
      setupScript: "echo core-e2e-setup",
      changeSource: "api",
      changeReason: "initial profile",
    },
  });
  expectStatus(response, [200], "update profile");
  let agent = asRecord(response.json);
  expect(agent.role === "qa-engineer", "Profile role not applied");
  expect(
    JSON.stringify(agent.capabilities) === JSON.stringify(["testing", "triage"]),
    "Profile capabilities not applied",
  );
  expect(asRecord(agent.avatar).icon === "bot", "Profile avatar not applied");
  expect(asRecord(agent.slackIcon).emoji === ":owl:", "Profile slackIcon not applied");
  expect(agent.soulMd === soulV1, "Profile soulMd not applied");

  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
    body: { soulMd: soulV2, changeSource: "api", changeReason: "second revision" },
  });
  expectStatus(response, [200], "second soul revision");
  const versions = ctx.db.query<{ version: number; changeReason: string | null; content: string }>(
    "SELECT version, changeReason, content FROM context_versions WHERE agentId = ? AND field = 'soulMd' ORDER BY version",
    [agentId],
  );
  expect(
    versions.length === 2 && versions[0]?.version === 1 && versions[1]?.version === 2,
    `Expected soulMd versions 1 and 2, got ${JSON.stringify(versions.map((row) => row.version))}`,
  );
  expect(versions[1]?.changeReason === "second revision", "Version 2 lost its change reason");
  expect(versions[0]?.content === soulV1, "Version 1 does not hold the first soul");

  // avatar: null resets, then the role guard, the empty body, the unknown agent.
  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, { body: { avatar: null } });
  expectStatus(response, [200], "reset avatar");
  expect(asRecord(response.json).avatar === null, "avatar: null did not reset the avatar");
  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
    body: { role: "extension" },
  });
  expectStatus(response, [400], "reserved extension role");
  expect(
    String(asRecord(response.json).error).includes("reserved"),
    "Reserved-role 400 lacks reason",
  );
  expectStatus(
    await ctx.api("PUT", `/api/agents/${agentId}/profile`, { body: {} }),
    [400],
    "empty profile",
  );
  expectStatus(
    await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
      body: { avatar: { type: "lucide" } },
    }),
    [400],
    "malformed avatar",
  );
  expectStatus(
    await ctx.api("PUT", "/api/agents/00000000-0000-4000-8000-00000000dead/profile", {
      body: { role: "ghost" },
    }),
    [404],
    "profile of an unknown agent",
  );

  // Identity budget: a first write above the soulMd budget is rejected with the details.
  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
    body: { soulMd: "B".repeat(12_000), changeSource: "api" },
  });
  expectStatus(response, [400], "soulMd over budget");
  const rejection = asRecord(asRecord(response.json).profileSyncRejection);
  expect(
    rejection.field === "soulMd" && rejection.budget === 10_000 && rejection.diskSize === 12_000,
    `Unexpected profileSyncRejection ${JSON.stringify(rejection)}`,
  );
  expect((await readAgent(ctx, agentId)).soulMd === soulV2, "Rejected write changed soulMd");

  // Compare-and-set: a stale hash drops only that field and records a conflict event.
  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
    body: {
      soulMd: "late overwrite",
      role: "cas-role",
      changeSource: "session_sync",
      expectedHashes: { soulMd: "a".repeat(64) },
    },
  });
  expectStatus(response, [200], "stale compare-and-set");
  agent = asRecord(response.json);
  expect(agent.role === "cas-role", "Non-conflicting field was dropped with the conflict");
  expect(agent.soulMd === soulV2, "Conflicting field was applied despite the stale hash");
  response = await ctx.api(
    "GET",
    `/api/events?agentId=${agentId}&event=system.profile_sync_conflict`,
  );
  expectStatus(response, [200], "read conflict events");
  const conflicts = asRecords(response.json, "events");
  expect(
    conflicts.length === 1 && asRecord(conflicts[0]?.data).field === "soulMd",
    "No profile_sync_conflict event for the dropped soulMd",
  );

  // A `changedByAgentId` that names no agent is a 404, not a FOREIGN KEY 500.
  response = await ctx.api("PUT", `/api/agents/${agentId}/profile`, {
    body: {
      soulMd: soulV1,
      changeSource: "lead_coaching",
      changedByAgentId: `ghost-${ctx.nonce}`,
    },
  });
  expectStatus(response, [404], "profile with an unknown changedByAgentId");
  expect(
    asRecord(response.json).error === "changed_by_agent_not_found",
    `Unexpected error for the unknown changedByAgentId: ${JSON.stringify(response.json)}`,
  );

  // GET /api/agents/{id}/setup-script returns the profile script and the global one.
  response = await ctx.api("GET", `/api/agents/${agentId}/setup-script`);
  expectStatus(response, [200], "read setup script");
  expect(
    asRecord(response.json).setupScript === "echo core-e2e-setup",
    "setup-script does not return the profile script",
  );
  expect("globalSetupScript" in asRecord(response.json), "setup-script lacks globalSetupScript");
  expectStatus(
    await ctx.api("GET", "/api/agents/00000000-0000-4000-8000-00000000dead/setup-script"),
    [404],
    "setup script of an unknown agent",
  );

  // GET /api/agents/{id}/task-activity counts today's task, 404 for an unknown agent.
  const taskId = await createAssignedTask(ctx, agentId, `activity probe ${ctx.nonce}`);
  response = await ctx.api("GET", `/api/agents/${agentId}/task-activity?days=7`);
  expectStatus(response, [200], "task activity");
  const days = asRecords(response.json, "days");
  const today = new Date().toISOString().slice(0, 10);
  expect(
    days.some((day) => day.date === today && Number(day.count) >= 1),
    `task-activity has no entry for ${today}: ${JSON.stringify(days)}`,
  );
  expectStatus(
    await ctx.api("GET", `/api/agents/${agentId}/task-activity?days=0`),
    [400],
    "task activity days=0",
  );
  expectStatus(
    await ctx.api("GET", "/api/agents/00000000-0000-4000-8000-00000000dead/task-activity"),
    [404],
    "task activity of an unknown agent",
  );
  await cancelQuietly(ctx, taskId);

  return agentId;
}

/** Harness provider and runtime settings, persisted as agent-scoped swarm_config rows. */
async function harnessAndRuntime(ctx: ScenarioContext, agentId: string): Promise<void> {
  // PATCH /api/agents/{id}/harness-provider
  let response = await ctx.api("PATCH", `/api/agents/${agentId}/harness-provider`, {
    body: { harness_provider: "codex" },
  });
  expectStatus(response, [200], "set harness provider");
  expect(asRecord(response.json).harnessProvider === "codex", "harnessProvider not applied");
  expect(
    configValue(ctx, agentId, "HARNESS_PROVIDER") === "codex",
    "No HARNESS_PROVIDER config row",
  );
  expectStatus(
    await ctx.api("PATCH", `/api/agents/${agentId}/harness-provider`, {
      body: { harness_provider: "not-a-harness" },
    }),
    [400],
    "unknown harness provider",
  );
  expectStatus(
    await ctx.api("PATCH", "/api/agents/00000000-0000-4000-8000-00000000dead/harness-provider", {
      body: { harness_provider: "codex" },
    }),
    [404],
    "harness provider of an unknown agent",
  );

  // GET/PATCH /api/agents/{id}/runtime: Claude transport.
  response = await ctx.api("GET", `/api/agents/${agentId}/runtime`);
  expectStatus(response, [200], "read runtime");
  let claude = asRecord(asRecord(response.json).claude);
  expect(claude.transport === null, "A fresh agent has an explicit Claude transport");
  expect(
    ["cli", "sdk"].includes(String(claude.effectiveTransport)) &&
      ["cli", "sdk"].includes(String(claude.inheritedTransport)) &&
      typeof claude.bridgeEffective === "boolean",
    "Runtime metadata is malformed",
  );
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", claude: { transport: "sdk" } },
  });
  expectStatus(response, [200], "set claude transport");
  expect(
    asRecord(response.json).harnessProvider === "claude",
    "Runtime PATCH did not switch harness",
  );
  expect(configValue(ctx, agentId, "CLAUDE_TRANSPORT") === "sdk", "No CLAUDE_TRANSPORT config row");
  claude = asRecord(asRecord((await ctx.api("GET", `/api/agents/${agentId}/runtime`)).json).claude);
  expect(
    claude.transport === "sdk" && claude.effectiveTransport === "sdk",
    "GET runtime does not report the explicit sdk transport",
  );
  expect(
    asRecord((await readAgent(ctx, agentId)).claudeTransport === "sdk" ? {} : { x: 1 }).x ===
      undefined,
    "Agent detail does not carry the effective claudeTransport",
  );

  // Model, effort and profile: catalog guard, tri-state clearing, exclusivity.
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", model: `not-a-real-model-${agentId.slice(0, 6)}` },
  });
  expectStatus(response, [400], "unknown model");
  expect(String(asRecord(response.json).error).includes("model catalog"), "Model 400 lacks reason");
  // A catalog model with a level that model supports.
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", model: "opus", reasoning_effort: "high" },
  });
  expectStatus(response, [200], "catalog model with a supported effort");
  expect(configValue(ctx, agentId, "MODEL_OVERRIDE") === "opus", "No MODEL_OVERRIDE row");
  expect(
    configValue(ctx, agentId, "REASONING_EFFORT_OVERRIDE") === "high",
    "No effort override row",
  );
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", reasoning_effort: "off" },
  });
  expectStatus(response, [400], "effort the model does not support");
  let allowed = asRecord(response.json).allowed;
  expect(
    Array.isArray(allowed) && allowed.includes("high") && !allowed.includes("off"),
    `Effort 400 lists the wrong allowed levels: ${JSON.stringify(allowed)}`,
  );
  // A custom model is accepted with allow_custom_model. The capability table knows no levels
  // for it, so an effort for it is refused: "must be one the harness and model support".
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", model: "core-custom-model", allow_custom_model: true },
  });
  expectStatus(response, [200], "custom model with allow_custom_model");
  expect(
    configValue(ctx, agentId, "MODEL_OVERRIDE") === "core-custom-model",
    "No custom MODEL_OVERRIDE",
  );
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", reasoning_effort: "high" },
  });
  expectStatus(response, [400], "effort for a custom model");
  allowed = asRecord(response.json).allowed;
  expect(
    Array.isArray(allowed) && allowed.length === 0,
    `A custom model should support no efforts, got ${JSON.stringify(allowed)}`,
  );
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", model: "latest:anthropic/opus" },
  });
  expectStatus(response, [400], "latest alias as agent model");
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", profile: "claude-smart", model: "sonnet" },
  });
  expectStatus(response, [400], "profile and model together");
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", profile: `no-such-profile-${ctx.nonce}` },
  });
  expectStatus(response, [400], "unknown profile");
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", profile: "codex-regular" },
  });
  expectStatus(response, [400], "profile of another harness");
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", profile: "claude-smart" },
  });
  expectStatus(response, [200], "set default profile");
  expect(configValue(ctx, agentId, "MODEL_PROFILE") === "claude-smart", "No MODEL_PROFILE row");
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", model: null, reasoning_effort: null, profile: null },
  });
  expectStatus(response, [200], "clear runtime overrides");
  for (const key of ["MODEL_OVERRIDE", "REASONING_EFFORT_OVERRIDE", "MODEL_PROFILE"]) {
    expect(configValue(ctx, agentId, key) === null, `${key} survived the null clear`);
  }
  response = await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
    body: { harness_provider: "claude", claude: { transport: null } },
  });
  expectStatus(response, [200], "clear claude transport");
  expect(configValue(ctx, agentId, "CLAUDE_TRANSPORT") === null, "CLAUDE_TRANSPORT survived null");

  // Harness-specific blocks need their own harness.
  expectStatus(
    await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
      body: { harness_provider: "codex", claude: { transport: "cli" } },
    }),
    [400],
    "claude block on codex",
  );
  expectStatus(
    await ctx.api("PATCH", `/api/agents/${agentId}/runtime`, {
      body: { harness_provider: "claude", acp: { target: "opencode" } },
    }),
    [400],
    "acp block on claude",
  );
  expectStatus(
    await ctx.api("PATCH", "/api/agents/00000000-0000-4000-8000-00000000dead/runtime", {
      body: { harness_provider: "claude" },
    }),
    [404],
    "runtime of an unknown agent",
  );
  expectStatus(
    await ctx.api("GET", "/api/agents/00000000-0000-4000-8000-00000000dead/runtime"),
    [404],
    "read runtime of an unknown agent",
  );
}

/** Read-only agent views: runtime instances, skills, MCP servers. */
async function agentViews(ctx: ScenarioContext, agentId: string): Promise<void> {
  let response = await ctx.api("GET", `/api/agents/${agentId}/runtime-instances`);
  expectStatus(response, [200], "runtime instances");
  expect(
    asRecords(response.json, "runtimeInstances").length === 0,
    "Runtime instances exist although MULTI_RUNTIME_ENABLED is off",
  );
  expect(
    typeof asRecord(response.json).staleThresholdMinutes === "number",
    "runtime-instances lacks staleThresholdMinutes",
  );
  expectStatus(
    await ctx.api("GET", "/api/agents/00000000-0000-4000-8000-00000000dead/runtime-instances"),
    [404],
    "runtime instances of an unknown agent",
  );

  response = await ctx.api("GET", `/api/agents/${agentId}/skills`);
  expectStatus(response, [200], "agent skills");
  const skills = asRecords(response.json, "skills");
  const listed = asRecord(response.json);
  expect(
    skills.length > 0 && listed.total === skills.length,
    "Skill list is empty or total drifts",
  );
  expect(
    typeof listed.signature === "string" && listed.signature.length === 64,
    "Skill list lacks a sha256 signature",
  );
  response = await ctx.api("GET", `/api/agents/${agentId}/skills/signature`);
  expectStatus(response, [200], "skill signature");
  const signature = asRecord(response.json);
  expect(
    signature.hash === listed.signature && signature.count === skills.length,
    "Signature probe disagrees with the skill list",
  );
  expect(typeof signature.generatedAt === "string", "Signature lacks generatedAt");
  response = await ctx.api("GET", `/api/agents/${agentId}/skills/bundle`);
  expectStatus(response, [200], "skill bundle");
  const bundle = asRecord(response.json);
  expect(
    bundle.signature === listed.signature && bundle.total === skills.length,
    "Skill bundle disagrees with the skill list",
  );

  for (const suffix of ["", "?resolveSecrets=true"]) {
    response = await ctx.api("GET", `/api/agents/${agentId}/mcp-servers${suffix}`);
    expectStatus(response, [200], `agent mcp-servers${suffix}`);
    expect(
      asRecords(response.json, "servers").length === 0 && asRecord(response.json).total === 0,
      "A fresh agent has installed MCP servers",
    );
  }
}

export const coreAgentProfile: Scenario = {
  name: "core-agent-profile",
  order: 200,
  async run(ctx) {
    const agentId = await identityAndProfile(ctx);
    await harnessAndRuntime(ctx, agentId);
    await agentViews(ctx, agentId);
    expect(UUID.test(agentId), "Worker id is not a UUID");
  },
};
