import { asRecord, asString, expectStatus } from "../http";
import type { Scenario } from "../run";
import { cancelTask, registerAgent } from "./knowledge-helpers";
import { createUser } from "./platform-helpers";

/**
 * The dashboard authenticates with the operator key and names its logged-in
 * user in `X-Swarm-User-Id`. That user may write its own `personal/<user>/`
 * keys (a session follow-up inherits one), never another user's, and the
 * header alone grants nothing to an agent or a request without it.
 */
export const knowledgeAssetsDashboardUser: Scenario = {
  name: "knowledge-assets-dashboard-user",
  order: 561,
  async run(ctx) {
    const agent = await registerAgent(ctx, "dash-user");
    const owner = await createUser(ctx, "dash-owner");
    const other = await createUser(ctx, "dash-other");
    const ownKey = `personal/${owner.id}/e2e-${ctx.nonce}/`;
    const asOwner = { "X-Swarm-User-Id": owner.id };
    const taskBody = (extra: Record<string, unknown>) => ({
      task: `dashboard personal ${ctx.nonce}`,
      agentId: agent,
      routingReason: "human_pinned",
      source: "api",
      ...extra,
    });
    const cleanup: string[] = [];
    try {
      const root = await ctx.api("POST", "/api/tasks", {
        headers: asOwner,
        body: taskBody({ key: ownKey }),
      });
      expectStatus(root, [201], "operator + logged-in user creates a task in its personal key");
      const rootId = asString(asRecord(root.json).id, "root task id");
      cleanup.push(rootId);

      const followUp = await ctx.api("POST", "/api/tasks", {
        headers: asOwner,
        body: taskBody({ parentTaskId: rootId }),
      });
      expectStatus(followUp, [201], "a follow-up inherits the owner's personal key");
      const followUpJson = asRecord(followUp.json);
      cleanup.push(asString(followUpJson.id, "follow-up task id"));
      if (followUpJson.key !== ownKey) {
        throw new Error(`follow-up key ${String(followUpJson.key)}, expected ${ownKey}`);
      }

      for (const [label, options] of [
        [
          "another user's personal key",
          {
            headers: asOwner,
            body: taskBody({ key: `personal/${other.id}/e2e-${ctx.nonce}/` }),
          },
        ],
        ["the operator key with no logged-in user", { body: taskBody({ key: ownKey }) }],
        [
          "an agent naming a dashboard user",
          { headers: asOwner, agentId: agent, body: taskBody({ key: ownKey }) },
        ],
      ] as const) {
        const response = await ctx.api("POST", "/api/tasks", options);
        expectStatus(response, [403], `personal write refused for ${label}`);
      }

      // Same helper on another route: provider mappings.
      const mapping = (key: string) => ({
        providerId: "e2e-dash",
        providerKey: `/dash/${ctx.nonce}/${key}`,
        key,
      });
      let response = await ctx.api("POST", "/api/assets/mappings", {
        headers: asOwner,
        body: mapping(ownKey),
      });
      expectStatus(response, [200], "map a file into the owner's personal key");
      response = await ctx.api("POST", "/api/assets/mappings", {
        headers: asOwner,
        body: mapping(`personal/${other.id}/e2e-${ctx.nonce}/`),
      });
      expectStatus(response, [403], "map a file into another user's personal key");
    } finally {
      for (const id of cleanup) await cancelTask(ctx, id);
    }
  },
};
