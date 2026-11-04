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

// "Continue with your swarm": the dashboard trades its user session for a named
// agent-fs key that rides back to the live app in the URL fragment only.
export const platformbFsContinue: Scenario = {
  name: "platformb-fs-continue",
  order: 684,
  async run(ctx) {
    const cleanup = new Cleanup();
    const configIds: string[] = [];
    let userToken: string | undefined;
    const orgId = crypto.randomUUID();
    const driveId = crypto.randomUUID();
    const agentFsUserId = crypto.randomUUID();
    const bootstrapKey = `af_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const liveKey = `af_${crypto.randomUUID().replaceAll("-", "").repeat(2)}`;
    const email = `fs-continue-${ctx.nonce}@example.com`;
    const labels: string[] = [];
    let mode: "ready" | "pending" | "unsupported" = "ready";
    const upstream = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === `/orgs/${orgId}/members`) {
          return Response.json({
            members: mode === "pending" ? [] : [{ userId: agentFsUserId, email, role: "editor" }],
          });
        }
        if (path === "/auth/register") {
          return Response.json(
            { error: "REGISTRATION_DOMAIN_NOT_ALLOWED", message: "Registration is closed" },
            { status: 403 },
          );
        }
        if (path === `/orgs/${orgId}/members/${agentFsUserId}/keys`) {
          if (mode === "unsupported") return new Response("404 Not Found", { status: 404 });
          const body = asRecord(await request.json());
          labels.push(asString(body.label, "key label"));
          return Response.json(
            {
              apiKey: liveKey,
              id: "live-key",
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
      const returnTo = `https://live.agent-fs.dev/file/~/${orgId}/${driveId}/x.md`;
      expectStatus(
        await ctx.api("POST", "/api/fs/continue", { body: { returnTo } }),
        [401],
        "continue requires a user",
      );
      expectStatus(
        await ctx.api("POST", "/api/fs/continue", { apiKey: null, body: { returnTo } }),
        [401],
        "continue requires authentication",
      );

      const invited = await ctx.api("POST", "/api/invites", { body: { email } });
      expectStatus(invited, [201], "invite a filesystem user");
      const code = new URL(asString(asRecord(invited.json).inviteUrl, "invite URL")).pathname
        .split("/")
        .at(-1);
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

      for (const rejected of ["https://live.agent-fs.dev.evil.test/x.md", "https://evil.test/"]) {
        const response = await ctx.api("POST", "/api/fs/continue", {
          apiKey: token,
          body: { returnTo: rejected },
        });
        expectStatus(response, [400], `reject ${rejected}`);
        expect(
          asRecord(response.json).error === "invalid_return_to",
          "The rejected origin error differs from the contract",
        );
      }
      expect(labels.length === 0, "A rejected origin minted a key");

      const continued = await ctx.api("POST", "/api/fs/continue", {
        apiKey: token,
        body: { returnTo: `${returnTo}#stale` },
      });
      expectStatus(continued, [200], "continue to the live app");
      expect(
        asRecord(continued.json).redirectUrl === `${returnTo}#key=${liveKey}`,
        "The redirect URL does not carry the key as its only fragment",
      );
      expect(continued.headers.get("cache-control") === "no-store", "The redirect is cacheable");
      expect(!continued.text.includes(bootstrapKey), "The response exposed the bootstrap key");
      expect(
        labels.length === 1 && /^live\.agent-fs\.dev · \d{4}-\d{2}-\d{2}$/.test(labels[0] ?? ""),
        "The minted key label differs from the contract",
      );

      mode = "pending";
      expectStatus(
        await ctx.api("POST", "/api/fs/continue", { apiKey: token, body: { returnTo } }),
        [409],
        "pending membership prevents continue",
      );
      mode = "unsupported";
      const unsupported = await ctx.api("POST", "/api/fs/continue", {
        apiKey: token,
        body: { returnTo },
      });
      expectStatus(unsupported, [501], "old agent-fs cannot continue");
      expect(
        asRecord(unsupported.json).error === "agent_fs_too_old",
        "The old-server error differs from the contract",
      );
    });
  },
};
