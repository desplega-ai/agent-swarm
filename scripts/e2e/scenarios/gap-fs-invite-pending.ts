import { asRecord, expect, expectStatus } from "../http";
import { SkipError } from "../report";
import type { Scenario } from "../run";

/**
 * agent-swarm #2478: POST /api/fs/members/invite returns the agent-fs pending-invite
 * state (status + acceptUrl) instead of dropping it.
 *
 * Needs a local agent-fs daemon (>= 0.18.9). Run through the wrapper
 * `scripts/e2e-gap/run-fs-invite.sh`, which starts the daemon and sets:
 *   GAP_AFS_URL     daemon base URL (also passed to the SUT as AGENT_FS_API_URL)
 *   GAP_AFS_MODE    "url" (daemon has AGENT_FS_APP_URL) or "nourl" (it has none)
 *   GAP_AFS_APP_URL the daemon's app URL in "url" mode
 */
export const gapFsInvitePending: Scenario = {
  name: "gap-fs-invite-pending",
  order: 1300,
  groups: ["gap"],
  async run(ctx) {
    const afs = process.env.GAP_AFS_URL;
    const mode = process.env.GAP_AFS_MODE;
    if (!afs || !mode)
      throw new SkipError(
        "GAP_AFS_URL / GAP_AFS_MODE not set (use scripts/e2e-gap/run-fs-invite.sh)",
      );

    const invite = (email: string, role?: string) =>
      ctx.api("POST", "/api/fs/members/invite", { body: { email, ...(role ? { role } : {}) } });

    // 1. unknown email -> pending
    const nobody = `nobody-yet-${ctx.nonce}@example.com`;
    let res = await invite(nobody);
    expectStatus(res, [200], "invite unknown email");
    let body = asRecord(res.json);
    expect(
      body.status === "pending",
      `unknown email: status ${String(body.status)}, expected pending`,
    );
    expect(body.invited === true, `unknown email: invited ${String(body.invited)}, expected true`);
    expect(typeof body.inviteId === "string" && body.inviteId.length > 0, "pending: no inviteId");
    expect(
      typeof body.expiresAt === "string" && !Number.isNaN(Date.parse(body.expiresAt)),
      "pending: no valid expiresAt",
    );
    expect(typeof body.orgId === "string", "pending: no orgId");
    expect(!("token" in body), "raw upstream token must not be forwarded");
    if (mode === "url") {
      const url = String(body.acceptUrl ?? "");
      expect(
        url.startsWith(`${process.env.GAP_AFS_APP_URL}/invite#`),
        `acceptUrl is ${url ? url.replace(/#.*/, "#<t>") : "<absent>"}, expected <appUrl>/invite#<token>`,
      );
      expect(/#[A-Za-z0-9_-]{43}$/.test(url), "acceptUrl token has an unexpected shape");
    } else {
      expect(!("acceptUrl" in body), "daemon without app URL: acceptUrl must be absent");
    }

    // The link must work on agent-fs itself: the public preview resolves the token to this email.
    if (mode === "url") {
      const token = String(body.acceptUrl).split("#")[1] ?? "";
      const preview = await fetch(`${afs}/invites/${token}`);
      const pv = (await preview.json()) as { email?: string };
      expect(
        preview.status === 200 && pv.email === nobody,
        `agent-fs preview of the returned link: ${preview.status} ${pv.email ?? ""}`,
      );
      const bad = await fetch(`${afs}/invites/${token.slice(0, -1)}x`);
      expect(bad.status === 404, `mangled token gave ${bad.status}, expected 404`);
    }
    const firstUrl = body.acceptUrl;

    // 2. same email again -> still pending (re-invite replaces the old link), not an error
    res = await invite(nobody);
    expectStatus(res, [200], "re-invite pending email");
    expect(asRecord(res.json).status === "pending", "re-invite: expected pending again");
    if (mode === "url")
      expect(asRecord(res.json).acceptUrl !== firstUrl, "re-invite should issue a new link");

    // 3. email with an account -> added immediately, no link
    const existing = `has-account-${ctx.nonce}@example.com`;
    const reg = await fetch(`${afs}/auth/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: existing }),
    });
    expect(reg.status === 200, `could not register ${existing} on agent-fs: ${reg.status}`);
    res = await invite(existing);
    expectStatus(res, [200], "invite existing account");
    body = asRecord(res.json);
    expect(
      body.status === "added" && body.invited === true,
      `existing account: ${JSON.stringify({ status: body.status, invited: body.invited })}`,
    );
    expect(
      !("acceptUrl" in body) && !("inviteId" in body),
      "added: must not carry pending-only fields",
    );

    // 4. inviting the same account again at the same role -> already_member, invited false
    res = await invite(existing);
    expectStatus(res, [200], "re-invite existing member");
    body = asRecord(res.json);
    expect(
      body.status === "already_member" && body.invited === false,
      `existing member: ${JSON.stringify({ status: body.status, invited: body.invited })}`,
    );

    // 5. validation + auth negatives
    res = await invite("not-an-email");
    expect(res.status === 400, `bad email gave ${res.status}, expected 400`);
    const noAuth = await fetch(`${ctx.baseUrl}/api/fs/members/invite`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "x@example.com" }),
    });
    expect(noAuth.status === 401, `no auth gave ${noAuth.status}, expected 401`);
  },
};
