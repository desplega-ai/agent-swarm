import { asString, expect, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { postSigned } from "../slack-http";
import { createUser } from "./platform-helpers";
import { registerLead } from "./slack-helpers";
import { enableNativeHttp, GENERAL_CHANNEL, type NativeHttpSlack } from "./slack-http-helpers";

const OTHER_TEAM = "T0PARTNER0";

function messageTs(seed: number): string {
  return `${Math.floor(Date.now() / 1000)}.${String(seed).padStart(6, "0")}`;
}

/** A signed `message` event in #general mentioning the bot, from `user` on `userTeam`. */
function mentionBody(
  flip: NativeHttpSlack,
  input: { eventId: string; user: string; userTeam: string; ts: string; text: string },
): string {
  const team = flip.mock.team.id;
  return JSON.stringify({
    token: "mock-verification-token",
    team_id: team,
    api_app_id: "A0MOCK0000",
    type: "event_callback",
    event_id: input.eventId,
    event_time: Math.floor(Date.now() / 1000),
    authorizations: [{ team_id: team, is_bot: true, is_enterprise_install: false }],
    event: {
      type: "message",
      channel: GENERAL_CHANNEL,
      channel_type: "channel",
      user: input.user,
      user_team: input.userTeam,
      source_team: input.userTeam,
      team,
      text: `<@${flip.mock.bot.userId}> ${input.text}`,
      ts: input.ts,
      event_ts: input.ts,
    },
  });
}

function requesterOf(ctx: ScenarioContext, ts: string): { found: boolean; userId: string | null } {
  const row = ctx.db.get<{ requestedByUserId: string | null }>(
    "SELECT requestedByUserId FROM agent_tasks WHERE source = 'slack' AND (slackTriggerMessageTs = ? OR slackThreadTs = ?)",
    [ts, ts],
  );
  return { found: row !== null && row !== undefined, userId: row?.requestedByUserId ?? null };
}

function slackAliasOwner(ctx: ScenarioContext, slackUserId: string): string | null {
  return (
    ctx.db.get<{ userId: string }>(
      "SELECT userId FROM user_external_ids WHERE kind = 'slack' AND externalId = ?",
      [slackUserId],
    )?.userId ?? null
  );
}

/**
 * The Slack profile email links a sender to the swarm user with that email only when the
 * sender is on this Slack team. A sender from another team (a Slack Connect partner) whose
 * profile carries the same email gets a task with no requester and no Slack alias.
 */
export const slackHttpCrossTeamIdentity: Scenario = {
  name: "slack-http-cross-team-identity",
  order: 179.2,
  async run(ctx) {
    const flip = await enableNativeHttp(ctx);
    try {
      const leadId = await registerLead(flip.ctx, "e2e-lead-http-cross-team");
      const n = ctx.nonce.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 10);
      const colleague = await createUser(ctx, "cross-team colleague", {
        email: `colleague-${n}@corp.test`,
      });
      const owner = await createUser(ctx, "cross-team owner", { email: `owner-${n}@corp.test` });

      const inTeam = flip.mock.addUser({ name: `peer-${n}`, email: colleague.email as string });
      const partner = flip.mock.addUser({ name: `partner-${n}`, email: owner.email as string });

      const send = async (user: string, userTeam: string, seed: number, label: string) => {
        const ts = messageTs(seed);
        const response = await postSigned(
          ctx,
          flip.eventsUrl,
          flip.signingSecret,
          mentionBody(flip, {
            eventId: `Ev${n.toUpperCase()}${seed}`.slice(0, 18),
            user,
            userTeam,
            ts,
            text: `swarm#${leadId} ${label}`,
          }),
        );
        expect(response.status === 200, `${label} event got ${response.status}, expected 200`);
        expect(
          await pollUntil(() => requesterOf(ctx, ts).found, 30_000),
          `No Slack task for the ${label} message within 30 seconds`,
        );
        return requesterOf(ctx, ts).userId;
      };

      // Control: a sender on this team is linked to the user with the same email.
      const teamRequester = await send(inTeam.id, flip.mock.team.id, 111111, "same team");
      expect(
        teamRequester === colleague.id,
        `Same-team requester was ${teamRequester}, expected ${colleague.id}`,
      );
      expect(
        slackAliasOwner(ctx, inTeam.id) === colleague.id,
        "The same-team sender's Slack id was not linked to the user with its email",
      );

      // A sender from another team with the same kind of email is not linked.
      const partnerRequester = await send(partner.id, OTHER_TEAM, 222222, "other team");
      expect(
        partnerRequester !== asString(owner.id, "owner id"),
        "A sender from another Slack team became the requester of the user with its email",
      );
      expect(
        slackAliasOwner(ctx, partner.id) === null,
        `A sender from another Slack team got a Slack alias on user ${slackAliasOwner(ctx, partner.id)}`,
      );
    } finally {
      await flip.undo();
    }
  },
};
