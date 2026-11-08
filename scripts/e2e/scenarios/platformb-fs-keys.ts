import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { Cleanup } from "./platformb-helpers";

async function setConfig(ctx: ScenarioContext, key: string, value: string): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: key.endsWith("API_KEY") },
  });
  expectStatus(response, [200], `set ${key}`);
  return asString(asRecord(response.json).id, `${key} config id`);
}

export const platformbFsKeys: Scenario = {
  name: "platformb-fs-keys",
  order: 683,
  async run(ctx) {
    const cleanup = new Cleanup();
    const configIds: string[] = [];
    let userToken: string | undefined;
    const orgId = crypto.randomUUID();
    const driveId = crypto.randomUUID();
    const agentFsUserId = crypto.randomUUID();
    const bootstrapKey = `af_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const personalKey = `af_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const email = `fs-keys-${ctx.nonce}@example.com`;
    let mode: "ready" | "pending" | "unsupported" = "ready";
    const seen: Array<{ path: string; authorization: string | null }> = [];
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        seen.push({ path, authorization: request.headers.get("authorization") });
        if (path === `/orgs/${orgId}/members`) {
          return Response.json({
            members: mode === "pending" ? [] : [{ userId: agentFsUserId, email, role: "editor" }],
          });
        }
        if (path === "/auth/register") {
          expect(
            request.headers.get("authorization") === null,
            "Registration received a credential",
          );
          return Response.json(
            {
              error: "REGISTRATION_DOMAIN_NOT_ALLOWED",
              message: "Registration is not open for this email domain",
            },
            { status: 403 },
          );
        }
        if (path === `/orgs/${orgId}/members/${agentFsUserId}/keys`) {
          if (mode === "unsupported") return new Response("404 Not Found", { status: 404 });
          const body = asRecord(await request.json());
          return Response.json(
            {
              apiKey: personalKey,
              id: "personal-key",
              label: body.label,
              createdAt: new Date().toISOString(),
              userId: agentFsUserId,
              orgId,
            },
            { status: 201 },
          );
        }
        return Response.json(
          { error: "NOT_FOUND", message: `Org not found: ${orgId}` },
          { status: 404 },
        );
      },
    });
    cleanup.add("stop fake agent-fs", () => upstream.stop(true));
    cleanup.add("restore filesystem config", async () => {
      for (const id of configIds.toReversed()) {
        expectStatus(
          await ctx.api("DELETE", `/api/config/${id}`),
          [200],
          "remove filesystem config",
        );
      }
      const restored = await pollUntil(
        async () => {
          const response = await ctx.api("GET", "/api/fs/capabilities");
          if (response.status !== 200 || asRecord(response.json).providerId !== "local-fs")
            return false;
          if (!userToken) return true;
          const account = await ctx.api("GET", "/api/fs/me", { apiKey: userToken });
          return account.status === 200 && asRecord(account.json).status === "off";
        },
        15_000,
        200,
      );
      expect(restored, "Filesystem config did not return to the local provider");
    });

    await cleanup.around(async () => {
      expectStatus(await ctx.api("GET", "/api/fs/me"), [401], "identity requires a user");
      expectStatus(
        await ctx.api("POST", "/api/fs/keys", { body: { label: "missing identity" } }),
        [401],
        "key creation requires a user",
      );
      expectStatus(
        await ctx.api("GET", "/api/fs/me", { apiKey: null }),
        [401],
        "identity requires authentication",
      );

      const invited = await ctx.api("POST", "/api/invites", { body: { email } });
      expectStatus(invited, [201], "invite a filesystem user");
      const inviteBody = asRecord(invited.json);
      const userId = asString(asRecord(inviteBody.user).id, "invited user id");
      const code = new URL(asString(inviteBody.inviteUrl, "invite URL")).pathname.split("/").at(-1);
      const exchange = await ctx.api("POST", "/api/invites/exchange", {
        apiKey: null,
        body: { code },
      });
      expectStatus(exchange, [200], "activate the filesystem user");
      const token = asString(asRecord(exchange.json).token, "user token");
      userToken = token;

      for (const [key, value] of Object.entries({
        API_AGENT_FS_API_KEY: bootstrapKey,
        AGENT_FS_DEFAULT_ORG_ID: orgId,
        AGENT_FS_DEFAULT_DRIVE_ID: driveId,
        AGENT_FS_API_URL: `http://127.0.0.1:${upstream.port}`,
      }))
        configIds.push(await setConfig(ctx, key, value));
      const ready = await pollUntil(
        async () => {
          const response = await ctx.api("GET", "/api/fs/me", { apiKey: token });
          return response.status === 200 && asRecord(response.json).status === "ready";
        },
        15_000,
        200,
      );
      expect(ready, "The personal filesystem never became ready");
      const me = await ctx.api("GET", "/api/fs/me", { apiKey: token });
      expectStatus(me, [200], "read personal filesystem identity");
      const identity = asRecord(me.json);
      expect(
        identity.email === email &&
          identity.agentFsUserId === agentFsUserId &&
          identity.orgId === orgId &&
          identity.driveId === driveId,
        "The filesystem identity differs from the user",
      );
      const row = ctx.db.get<{ status: string }>("SELECT status FROM users WHERE id = ?", [userId]);
      expect(row?.status === "active", "The filesystem user is not active");

      const key = await ctx.api("POST", "/api/fs/keys", {
        apiKey: token,
        body: { label: "e2e laptop" },
      });
      expectStatus(key, [201], "create a personal filesystem key");
      const credential = asRecord(key.json);
      expect(
        credential.apiKey === personalKey &&
          credential.keyId === "personal-key" &&
          credential.label === "e2e laptop" &&
          credential.agentFsUserId === agentFsUserId &&
          credential.orgId === orgId &&
          credential.driveId === driveId,
        "The personal key response differs from the upstream credential",
      );
      expect(key.headers.get("cache-control") === "no-store", "The key response permits caching");
      expect(!key.text.includes(bootstrapKey), "The response exposed the bootstrap key");
      expect(
        seen
          .filter((request) => request.path !== "/auth/register")
          .every((request) => request.authorization === `Bearer ${bootstrapKey}`),
        "A provisioning request used the wrong credential",
      );

      mode = "pending";
      expectStatus(
        await ctx.api("POST", "/api/fs/keys", { apiKey: token, body: { label: "pending" } }),
        [409],
        "pending membership prevents key creation",
      );
      mode = "unsupported";
      const unsupported = await ctx.api("POST", "/api/fs/keys", {
        apiKey: token,
        body: { label: "old server" },
      });
      expectStatus(unsupported, [501], "old agent-fs cannot create personal keys");
      expect(
        asRecord(unsupported.json).error === "agent_fs_too_old",
        "The old-server error differs from the contract",
      );
    });
  },
};
