// Locks the HTTP status and error body each route sends today when the database refuses a
// write: unique conflicts, foreign-key violations and CHECK violations. Some routes map the
// database error to a stable code; others pass the database's own message through. Both
// are today's contract: another storage engine must keep the status and these bodies (or
// the routes must change on purpose, with this scenario).

import type { ApiResponse } from "../http";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";

const MISSING_AGENT = "00000000-0000-4000-8000-000000000000";

function expectError(response: ApiResponse, status: number, error: string, label: string): void {
  expectStatus(response, [status], label);
  expect(
    asRecord(response.json).error === error,
    `${label}: error body is ${response.text}, expected {"error":${JSON.stringify(error)}}`,
  );
}

type Cleanup = Array<() => Promise<unknown>>;

/** POST /api/users and POST /api/users/{id}/identities: mapped unique conflicts. */
async function users(ctx: ScenarioContext): Promise<void> {
  const email = `div-err-${ctx.nonce}@example.com`;
  const first = await ctx.api("POST", "/api/users", {
    body: { name: `Div err a ${ctx.nonce}`, email },
  });
  expectStatus(first, [200], "create user");
  const userId = asString(asRecord(asRecord(first.json).user).id, "user id");
  expectError(
    await ctx.api("POST", "/api/users", { body: { name: `Div err b ${ctx.nonce}`, email } }),
    409,
    "user_exists",
    "duplicate user email",
  );
  // The email key is case-sensitive today: another case is a new user.
  const upper = await ctx.api("POST", "/api/users", {
    body: { name: `Div err c ${ctx.nonce}`, email: email.toUpperCase() },
  });
  expectStatus(upper, [200], "same email, other case");
  const otherId = asString(asRecord(asRecord(upper.json).user).id, "user id");

  const identity = { kind: "slack", externalId: `UDIV${ctx.nonce.toUpperCase()}` };
  expectStatus(
    await ctx.api("POST", `/api/users/${userId}/identities`, { body: identity }),
    [200],
    "link identity",
  );
  expectError(
    await ctx.api("POST", `/api/users/${otherId}/identities`, { body: identity }),
    409,
    "identity_taken",
    "identity linked to a second user",
  );
}

/** POST and PUT /api/repos: a mapped unique conflict on url, name or clonePath. */
async function repos(ctx: ScenarioContext, cleanup: Cleanup): Promise<void> {
  const message = "Repo with that url, name, or clonePath already exists";
  const created: string[] = [];
  for (const suffix of ["a", "b"]) {
    const response = await ctx.api("POST", "/api/repos", {
      body: {
        url: `https://github.com/div-err/${ctx.nonce}-${suffix}`,
        name: `div-err-${ctx.nonce}-${suffix}`,
      },
    });
    expectStatus(response, [201], `create repo ${suffix}`);
    const id = asString(asRecord(response.json).id, "repo id");
    created.push(id);
    cleanup.push(() => ctx.api("DELETE", `/api/repos/${id}`));
  }
  expectError(
    await ctx.api("POST", "/api/repos", {
      body: { url: `https://github.com/div-err/${ctx.nonce}-a`, name: `div-err-${ctx.nonce}-c` },
    }),
    409,
    message,
    "duplicate repo url",
  );
  expectError(
    await ctx.api("POST", "/api/repos", {
      body: { url: `https://github.com/div-err/${ctx.nonce}-c`, name: `div-err-${ctx.nonce}-a` },
    }),
    409,
    message,
    "duplicate repo name",
  );
  expectError(
    await ctx.api("PUT", `/api/repos/${created[1]}`, { body: { name: `div-err-${ctx.nonce}-a` } }),
    409,
    message,
    "rename a repo onto another's name",
  );
}

/** POST /api/pricing/...: a mapped primary-key conflict. */
async function pricing(ctx: ScenarioContext, cleanup: Cleanup): Promise<void> {
  const path = `/api/pricing/claude/div-err-${ctx.nonce}/input`;
  expectStatus(
    await ctx.api("POST", path, { body: { pricePerMillionUsd: 1, effectiveFrom: 2_000 } }),
    [201],
    "insert pricing row",
  );
  cleanup.push(() => ctx.api("DELETE", `${path}/2000`));
  expectError(
    await ctx.api("POST", path, { body: { pricePerMillionUsd: 2, effectiveFrom: 2_000 } }),
    409,
    "Duplicate pricing row for (provider, model, tokenClass, effectiveFrom). Use a different effectiveFrom.",
    "duplicate pricing row",
  );
}

/** /api/mcp-servers: a mapped unique conflict, and raw foreign-key and CHECK messages. */
async function mcpServers(ctx: ScenarioContext, cleanup: Cleanup): Promise<void> {
  const body = { name: `div-err-${ctx.nonce}`, transport: "http", url: "https://example.com/mcp" };
  const created = await ctx.api("POST", "/api/mcp-servers", { body });
  expectStatus(created, [201], "create mcp server");
  const serverId = asString(asRecord(asRecord(created.json).server).id, "mcp server id");
  cleanup.push(() => ctx.api("DELETE", `/api/mcp-servers/${serverId}`));
  expectError(
    await ctx.api("POST", "/api/mcp-servers", { body }),
    409,
    "mcp_server_name_taken",
    "duplicate mcp server name",
  );
  // No pre-check on the owner: the foreign key refuses it and its message is the body.
  expectError(
    await ctx.api("POST", "/api/mcp-servers", {
      body: {
        ...body,
        name: `div-err-fk-${ctx.nonce}`,
        scope: "agent",
        ownerAgentId: MISSING_AGENT,
      },
    }),
    400,
    "FOREIGN KEY constraint failed",
    "mcp server owned by a missing agent",
  );
  expectError(
    await ctx.api("POST", `/api/mcp-servers/${serverId}/install`, {
      body: { agentId: MISSING_AGENT },
    }),
    400,
    "FOREIGN KEY constraint failed",
    "install an mcp server on a missing agent",
  );
  // `scope` is a free string on the wire; the CHECK constraint refuses it.
  expectError(
    await ctx.api("POST", "/api/mcp-servers", {
      body: { ...body, name: `div-err-chk-${ctx.nonce}`, scope: "bogus" },
    }),
    400,
    "CHECK constraint failed: scope IN ('global', 'swarm', 'agent')",
    "mcp server with an unknown scope",
  );
  const list = await ctx.api("GET", "/api/mcp-servers");
  expectStatus(list, [200], "list mcp servers");
  expect(
    !list.text.includes(`div-err-fk-${ctx.nonce}`) &&
      !list.text.includes(`div-err-chk-${ctx.nonce}`),
    "a refused mcp server was stored",
  );
}

/** /api/skills: raw unique and CHECK messages, as 400 on create and 500 on update. */
async function skills(ctx: ScenarioContext, cleanup: Cleanup): Promise<void> {
  const content = (name: string) => `---\nname: ${name}\ndescription: divergence probe\n---\nbody`;
  const name = `div-err-${ctx.nonce}`;
  const created = await ctx.api("POST", "/api/skills", { body: { content: content(name) } });
  expectStatus(created, [200, 201], "create skill");
  const skillId = asString(asRecord(asRecord(created.json).skill).id, "skill id");
  cleanup.push(() => ctx.api("DELETE", `/api/skills/${skillId}`));
  expectError(
    await ctx.api("POST", "/api/skills", { body: { content: content(name) } }),
    400,
    "UNIQUE constraint failed: index 'idx_skills_name_scope'",
    "duplicate skill name",
  );
  expectError(
    await ctx.api("POST", "/api/skills", {
      body: { content: content(`${name}-chk`), type: "bogus" },
    }),
    400,
    "CHECK constraint failed: type IN ('remote', 'personal')",
    "skill with an unknown type",
  );
  expectError(
    await ctx.api("PUT", `/api/skills/${skillId}`, { body: { scope: "bogus" } }),
    500,
    "CHECK constraint failed: scope IN ('global', 'swarm', 'agent')",
    "update a skill to an unknown scope",
  );
  const read = await ctx.api("GET", `/api/skills/${skillId}`);
  expectStatus(read, [200], "read skill");
  expect(
    asRecord(read.json).scope === "agent",
    `a refused update changed the skill: ${read.text.slice(0, 300)}`,
  );
}

export const divergenceErrorMapping: Scenario = {
  name: "divergence-error-mapping",
  order: 9_237,
  async run(ctx) {
    const cleanup: Cleanup = [];
    try {
      await users(ctx);
      await repos(ctx, cleanup);
      await pricing(ctx, cleanup);
      await mcpServers(ctx, cleanup);
      await skills(ctx, cleanup);
    } finally {
      for (const step of cleanup.reverse()) await step();
    }
  },
};
