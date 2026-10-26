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
    // The link is `<API>/invite/<code>`. The SUT reports its fallback origin
    // (localhost on its own port), so compare the port, not the host spelling.
    const link = new URL(invite.inviteUrl);
    const [, prefix, code = ""] = link.pathname.split("/");
    expect(prefix === "invite", `invite link opens /invite/<code>, got ${link.pathname}`);
    expect(CODE_PATTERN.test(code), "invite link carries a 43-char code");
    expect(link.port === new URL(ctx.baseUrl).port, "invite link points at this swarm's API");

    // Opening the link redirects to the dashboard's /join with the code in the
    // fragment. It does not spend the code: the exchange below still works.
    const opened = await fetch(new URL(link.pathname, ctx.baseUrl), { redirect: "manual" });
    expect(opened.status === 302, `opening the link redirects, got ${opened.status}`);
    const target = new URL(opened.headers.get("location") ?? "http://invalid");
    expect(target.pathname === "/join", `redirect opens /join, got ${target.pathname}`);
    expect(target.hash === `#code=${code}`, "redirect carries the code in the fragment");
    const swarm = new URL(target.searchParams.get("swarm") ?? "http://invalid");
    expect(swarm.port === new URL(ctx.baseUrl).port, "redirect carries this swarm's API origin");

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
