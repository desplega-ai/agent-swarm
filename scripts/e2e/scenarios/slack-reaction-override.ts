import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForOutcome,
  waitForReaction,
  waitForReactionAbsence,
} from "./slack-helpers";

export const slackReactionOverride: Scenario = {
  name: "slack-reaction-override",
  order: 110,
  async run(ctx) {
    const acceptedKey = "SLACK_REACTION_ACCEPTED";
    const completedKey = "SLACK_REACTION_COMPLETED";
    const configuredAccepted = "eyeglasses";
    const configuredCompleted = "tada";
    const overrides: Array<{ key: string; value: string }> = [
      { key: acceptedKey, value: configuredAccepted },
      { key: completedKey, value: configuredCompleted },
    ];
    const upserts = await Promise.all(
      overrides.map(async ({ key, value }) => {
        const upsert = await ctx.api("PUT", "/api/config", {
          body: { scope: "global", scopeId: null, key, value, isSecret: false },
        });
        expectStatus(upsert, [200], `configure ${key}`);
        const configId = asRecord(upsert.json).id;
        expect(typeof configId === "string", `Config upsert for ${key} has no id`);
        return String(configId);
      }),
    );

    try {
      // A global config write reloads process.env and restarts the Slack app
      // on a ~250ms debounce — wait for the override to actually be live
      // before driving a message through it.
      const live = await pollUntil(async () => {
        const response = await ctx.api(
          "GET",
          `/api/config/env-presence?keys=${acceptedKey},${completedKey}`,
        );
        expectStatus(response, [200], `check ${acceptedKey}/${completedKey} presence`);
        const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
        return presence?.[acceptedKey] === true && presence?.[completedKey] === true;
      }, 10_000);
      expect(
        live,
        `${acceptedKey}/${completedKey} never became visible in process.env within 10 seconds`,
      );

      // Registering a lead guarantees one exists when this scenario runs on
      // its own; when other Slack scenarios ran first, the swarm may still
      // route new messages to whichever of their leads `getLeadAgent()` still
      // considers non-offline. Read the task's own `agentId` back below
      // rather than assuming it's this freshly registered one.
      await registerLead(ctx, "e2e-lead-reaction-override");
      const message = await ask(ctx, "rename the staging bucket");
      ctx.markThread("reaction-override", "C0GENERAL0", message.ts);

      // The configured shortcode is what gets applied for acceptance, not
      // the "eyes" code default.
      await waitForReaction(ctx, message.ts, configuredAccepted);

      const task = await findSlackTask(ctx, message.ts);
      const taskId = String(task.id);
      const ownerLeadId = String(task.agentId);
      await claim(ctx, ownerLeadId, taskId);
      const output = "Staging bucket renamed.";
      await finish(ctx, ownerLeadId, taskId, { status: "completed", output });

      await waitForOutcome(ctx, message.ts, output);
      // Finalization must replace the configured acceptance reaction with
      // the configured terminal outcome, not leave the two sitting side by
      // side, and not fall back to either code default.
      await waitForReaction(ctx, message.ts, configuredCompleted);
      await waitForReactionAbsence(ctx, message.ts, configuredAccepted);

      const addedNames = ctx.slack
        .apiCalls("reactions.add")
        .filter((call) => call.args.timestamp === message.ts)
        .map((call) => call.args.name);
      expect(
        !addedNames.includes("eyes") && !addedNames.includes("white_check_mark"),
        `Expected only configured reaction names on ${message.ts}, got: ${addedNames.join(", ")}`,
      );
    } finally {
      for (const configId of upserts) {
        expectStatus(
          await ctx.api("DELETE", `/api/config/${configId}`),
          [200],
          `delete config ${configId}`,
        );
      }
      // The delete reloads process.env on the same debounce as the upsert.
      // Wait until the defaults are live again so a later scenario that
      // expects the code-default reaction names never observes the override.
      const reset = await pollUntil(async () => {
        const response = await ctx.api(
          "GET",
          `/api/config/env-presence?keys=${acceptedKey},${completedKey}`,
        );
        expectStatus(response, [200], `check ${acceptedKey}/${completedKey} absence`);
        const presence = asRecord(response.json).presence as Record<string, boolean> | undefined;
        return presence?.[acceptedKey] === false && presence?.[completedKey] === false;
      }, 10_000);
      expect(
        reset,
        `${acceptedKey}/${completedKey} were still visible in process.env 10 seconds after deletion`,
      );
    }
  },
};
