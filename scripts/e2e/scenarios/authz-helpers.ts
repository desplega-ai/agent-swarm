// Shared pieces of the authz-* scenarios: agent and user tokens, page sessions, and a restart
// with RBAC on (the e2e API boots with it off, so a user token then grants everything).
import type { SqlQuery } from "../db";
import { asRecord, asString, expect, expectStatus } from "../http";
import type { ScenarioContext } from "../run";

export const GATE_DENIED = "requires the lead agent, operator, or user";

export const count = (ctx: ScenarioContext, query: SqlQuery): number =>
  ctx.db.get<{ n: number }>(query)?.n ?? -1;

export async function mintAgentToken(ctx: ScenarioContext, agentId: string): Promise<string> {
  const response = await ctx.api("POST", `/api/agents/${agentId}/token`, { body: {} });
  expectStatus(response, [200], "mint an agent session token");
  const plaintext = asString(asRecord(response.json).plaintext, "token plaintext");
  expect(plaintext.startsWith("aseph_"), "the agent token has the aseph_ prefix");
  return plaintext;
}

/** A user with one primary role (`admin` or `viewer`) and a user token. */
export async function createUserToken(
  ctx: ScenarioContext,
  label: string,
  role: "admin" | "viewer",
): Promise<{ userId: string; token: string }> {
  const created = await ctx.api("POST", "/api/users", {
    body: { name: `${label} ${ctx.nonce}`, status: "active" },
  });
  expectStatus(created, [200], `create user ${label}`);
  const userId = asString(asRecord(asRecord(created.json).user).id, "user id");
  if (role !== "admin") {
    expectStatus(
      await ctx.api("PUT", `/api/users/${userId}/roles`, { body: { roles: [role] } }),
      [200],
      `set the ${role} role`,
    );
  }
  const minted = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, {
    body: { label: `${label} ${ctx.nonce}` },
  });
  expectStatus(minted, [200], `mint a token for ${label}`);
  return { userId, token: asString(asRecord(minted.json).plaintext, "user token") };
}

function cookiePair(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

/**
 * A page owned by `ownerAgentId`, launched by `viewer` (the operator key by default, or a user
 * token). Returns request options that call `/@swarm/api/*` as that page session.
 */
export async function launchPageSession(
  ctx: ScenarioContext,
  ownerAgentId: string,
  viewer: { apiKey?: string },
  label: string,
  pageIds: string[],
) {
  const created = await ctx.api("POST", "/api/pages", {
    agentId: ownerAgentId,
    body: {
      slug: `authz-${label}-${ctx.nonce}`,
      title: `Authz ${label}`,
      contentType: "text/html",
      authMode: "authed",
      body: "<p>authz</p>",
    },
  });
  expectStatus(created, [201], `create the ${label} page`);
  const pageId = asString(asRecord(created.json).id, "page id");
  pageIds.push(pageId);
  const launch = await ctx.api("POST", `/api/pages/${pageId}/launch`, viewer);
  expectStatus(launch, [204], `launch the ${label} page`);
  return {
    apiKey: null,
    headers: { Cookie: cookiePair(launch.headers), "X-Swarm-Page-Id": pageId },
  } as const;
}
