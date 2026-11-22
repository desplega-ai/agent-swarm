// A page launched with the operator key acts as the user the dashboard picked
// (`X-Swarm-User-Id`), the same self-declared identity favorites trust. No header, an
// unknown user, or an agent caller keeps the operator session. A user token wins over
// the header.
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { registerAgent } from "./knowledge-helpers";

const CALLER_SCRIPT = `export default async function main(args: { caller?: { kind: string; id: string | null; name?: string; pageId?: string } }) {
  return { kind: args.caller?.kind ?? null, id: args.caller?.id ?? null, name: args.caller?.name ?? null, pageId: args.caller?.pageId ?? null };
}
`;

function cookiePair(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

async function createUser(ctx: ScenarioContext, label: string): Promise<{ id: string; name: string }> {
  const name = `Page viewer ${label} ${ctx.nonce}`;
  const created = await ctx.api("POST", "/api/users", { body: { name, status: "active" } });
  expectStatus(created, [200], `create user ${label}`);
  return { id: asString(asRecord(asRecord(created.json).user).id, `${label} id`), name };
}

export const knowledgePageDashboardUser: Scenario = {
  name: "knowledge-page-dashboard-user",
  order: 545,
  async run(ctx) {
    const owner = await registerAgent(ctx, "page-picked-owner");
    const picked = await createUser(ctx, "picked");
    const tokenUser = await createUser(ctx, "token");
    const minted = await ctx.api("POST", `/api/users/${tokenUser.id}/mcp-tokens`, {
      body: { label: `page picked user ${ctx.nonce}` },
    });
    expectStatus(minted, [200], "mint a user token");
    const userToken = asString(asRecord(minted.json).plaintext, "user token");

    let pageId: string | undefined;
    let appId: string | undefined;
    try {
      const scriptName = `e2e-page-caller-${ctx.nonce}`;
      let response = await ctx.api("POST", "/api/scripts/upsert", {
        agentId: owner,
        body: {
          name: scriptName,
          scope: "agent",
          description: "Page caller fixture",
          intent: "Echo the verified app action caller",
          source: CALLER_SCRIPT,
        },
      });
      expectStatus(response, [200], "upsert the caller script");
      const listed = await ctx.api("GET", "/api/scripts?scope=agent&includeScratch=true");
      expectStatus(listed, [200], "list scripts");
      const scriptId = asString(
        asRecords(listed.json, "scripts").find(
          (script) => script.name === scriptName && script.scopeId === owner,
        )?.id,
        "caller script id",
      );

      response = await ctx.api("POST", "/api/apps", {
        agentId: owner,
        body: {
          name: `Page caller app ${ctx.nonce}`,
          definition: {
            models: { note: { columns: { text: { kind: "string", required: true } } } },
            queries: { notes: { model: "note", sort: { column: "createdAt", dir: "desc" } } },
            actions: { caller: { kind: "script", scriptId } },
            pages: {
              main: {
                root: "root",
                elements: { root: { type: "Heading", props: { text: "Notes" } } },
              },
            },
            defaultPage: "main",
          },
        },
      });
      expectStatus(response, [201], "create the app");
      appId = asString(asRecord(asRecord(response.json).app).id, "app id");

      response = await ctx.api("POST", "/api/pages", {
        agentId: owner,
        body: {
          slug: `page-picked-${ctx.nonce}`,
          title: "Picked user page",
          contentType: "text/html",
          authMode: "authed",
          body: "<p>picked</p>",
        },
      });
      expectStatus(response, [201], "create an authed page");
      pageId = asString(asRecord(response.json).id, "page id");
      const page = pageId;

      // Launch, then read who the page session is through the page proxy.
      const launchAs = async (label: string, opts: { apiKey?: string; agentId?: string; user?: string }) => {
        const launch = await ctx.api("POST", `/api/pages/${page}/launch`, {
          ...(opts.apiKey ? { apiKey: opts.apiKey } : {}),
          ...(opts.agentId ? { agentId: opts.agentId } : {}),
          headers: opts.user ? { "X-Swarm-User-Id": opts.user } : {},
        });
        expectStatus(launch, [204], `launch: ${label}`);
        const session = {
          apiKey: null,
          headers: { Cookie: cookiePair(launch.headers), "X-Swarm-Page-Id": page },
        } as const;
        const whoami = await ctx.api("GET", "/@swarm/api/whoami", session);
        expectStatus(whoami, [200], `whoami: ${label}`);
        const action = await ctx.api("POST", `/@swarm/api/apps/${appId}/actions/caller`, {
          ...session,
          body: {},
        });
        expectStatus(action, [200], `app action: ${label}`);
        return {
          session,
          whoami: asRecord(whoami.json),
          caller: asRecord(asRecord(action.json).result),
        };
      };

      // ── operator key + picked user: the session is that user ────────────────────────────────
      const asPicked = await launchAs("operator key with a picked user", { user: picked.id });
      expect(
        asPicked.whoami.kind === "user" && asRecord(asPicked.whoami.user).id === picked.id,
        `whoami names the picked user: ${JSON.stringify(asPicked.whoami).slice(0, 200)}`,
      );
      expect(
        asPicked.caller.kind === "user" &&
          asPicked.caller.id === picked.id &&
          asPicked.caller.name === picked.name &&
          asPicked.caller.pageId === page,
        `the app action caller is the picked user: ${JSON.stringify(asPicked.caller)}`,
      );
      response = await ctx.api("POST", `/@swarm/api/apps/${appId}/models/note/rows`, {
        ...asPicked.session,
        body: { values: { text: `note ${ctx.nonce}` } },
      });
      expectStatus(response, [201], "the picked user's page session writes a row");
      response = await ctx.api("GET", `/@swarm/api/apps/${appId}/queries/notes`, asPicked.session);
      expectStatus(response, [200], "the picked user's page session runs a query");
      expect(
        asRecords(response.json, "rows")[0]?.createdBy === `user:${picked.id}`,
        `the row is stamped with the picked user: ${response.text.slice(0, 200)}`,
      );

      // ── no header, an unknown user, an agent: operator, as before ───────────────────────────
      for (const [label, opts] of [
        ["operator key without a header", {}],
        ["operator key with an unknown user", { user: crypto.randomUUID() }],
        ["an agent naming a user", { agentId: owner, user: picked.id }],
      ] as const) {
        const launched = await launchAs(label, opts);
        expect(
          launched.whoami.kind === "operator" && launched.whoami.user === null,
          `${label}: whoami is the operator: ${JSON.stringify(launched.whoami).slice(0, 200)}`,
        );
        expect(
          launched.caller.kind === "operator" && launched.caller.id === null,
          `${label}: the app action caller is the operator: ${JSON.stringify(launched.caller)}`,
        );
      }

      // ── a user token wins over the header ───────────────────────────────────────────────────
      const asToken = await launchAs("user token with a picked user", {
        apiKey: userToken,
        user: picked.id,
      });
      expect(
        asToken.whoami.kind === "user" && asRecord(asToken.whoami.user).id === tokenUser.id,
        `whoami names the token's user: ${JSON.stringify(asToken.whoami).slice(0, 200)}`,
      );
      expect(
        asToken.caller.kind === "user" && asToken.caller.id === tokenUser.id,
        `the app action caller is the token's user: ${JSON.stringify(asToken.caller)}`,
      );
    } finally {
      if (pageId) await ctx.api("DELETE", `/api/pages/${pageId}`);
      if (appId) await ctx.api("DELETE", `/api/apps/${appId}`);
    }
  },
};
