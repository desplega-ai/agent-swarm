import { expect, expectStatus } from "../http";
import type { Scenario } from "../run";

// Teammate invite from the swarm side: the operator invites an email, the
// teammate's browser trades the link's code without auth, and the token it
// gets back resolves to the now-active user. A replay of the code is 404.
const CODE_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const invites: Scenario = {
  name: "invites",
  order: 76,
  async run(ctx) {
    const email = `invite-e2e-${ctx.nonce}@example.com`;

    expectStatus(
      await ctx.api("POST", "/api/invites", { apiKey: null, body: { email } }),
      [401],
      "inviting needs credentials",
    );

    const created = await ctx.api("POST", "/api/invites", { body: { email } });
    expectStatus(created, [201], "create invite");
    const invite = created.json as {
      user: { id: string; status: string };
      inviteUrl: string;
      expiresAt: string;
      apiReachable: string;
    };
    expect(invite.user.status === "invited", `user is invited, got ${invite.user.status}`);
    expect(Date.parse(invite.expiresAt) > Date.now(), "invite expires in the future");
    // The SUT runs on a loopback origin.
    expect(invite.apiReachable === "local", `apiReachable, got ${invite.apiReachable}`);
    const link = new URL(invite.inviteUrl);
    expect(link.pathname === "/join", "invite link opens /join");
    const code = link.searchParams.get("code") ?? "";
    expect(CODE_PATTERN.test(code), "invite link carries a 43-char code");
    // The SUT reports its fallback origin (localhost on its own port), so
    // compare the port rather than the host spelling.
    const swarm = new URL(link.searchParams.get("swarm") ?? "http://invalid");
    expect(swarm.port === new URL(ctx.baseUrl).port, "invite link carries this swarm's API origin");

    const exchanged = await ctx.api("POST", "/api/invites/exchange", {
      apiKey: null,
      body: { code },
    });
    expectStatus(exchanged, [200], "exchange invite code");
    const result = exchanged.json as { token: string; userId: string };
    expect(result.token.startsWith("aswt_"), "exchange returns an aswt_ token");
    expect(result.userId === invite.user.id, "exchange returns the invited user");

    const whoami = await ctx.api("GET", "/api/whoami", { apiKey: result.token });
    expectStatus(whoami, [200], "whoami with the invite token");
    const principal = whoami.json as { kind: string; user: { id: string; status: string } | null };
    expect(
      principal.kind === "user" && principal.user?.id === invite.user.id,
      "token resolves to the invited user",
    );
    expect(principal.user?.status === "active", "the exchange activated the user");

    const replay = await ctx.api("POST", "/api/invites/exchange", {
      apiKey: null,
      body: { code },
    });
    expectStatus(replay, [404], "replayed invite code");
    expect(
      (replay.json as { error?: string }).error === "code_invalid",
      "replay answers code_invalid",
    );

    expectStatus(
      await ctx.api("POST", "/api/invites", { body: { email } }),
      [409],
      "re-inviting an active user",
    );
  },
};
