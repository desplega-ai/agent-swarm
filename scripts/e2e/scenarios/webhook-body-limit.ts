// Public webhook receivers read the raw body before they verify a signature or token, and
// before they know whether the integration or workflow exists. They refuse a body over
// 5 MiB with 413, declared or streamed, and still answer a normal body as before.
import { expectStatus } from "../http";
import type { Scenario } from "../run";
import { expectWebhookBodyTooLarge } from "./platform-helpers";
import { createWorkflow } from "./workflow-helpers";

export const webhookBodyLimit: Scenario = {
  name: "webhook-body-limit",
  order: 644.5,
  async run(ctx) {
    const workflowId = await createWorkflow(
      ctx,
      "hook-body-limit",
      { nodes: [{ id: "note", type: "script", config: { runtime: "bash", script: "echo hi" } }] },
      { triggers: [{ type: "webhook", hmacSecret: `body-limit-${ctx.nonce}` }] },
    );
    const paths = [
      "/api/trackers/linear/webhook",
      `/api/trackers/jira/webhook/e2e-token-${ctx.nonce}`,
      `/api/webhooks/${crypto.randomUUID()}`,
      `/api/webhooks/${workflowId}`,
    ];
    for (const path of paths) await expectWebhookBodyTooLarge(ctx, path);

    // A small body still gets the route's own answer: not configured, unknown, unsigned.
    const small = JSON.stringify({ nonce: ctx.nonce });
    const expected: Array<[string, number]> = [
      [paths[0]!, 503],
      [paths[1]!, 503],
      [paths[2]!, 404],
      [paths[3]!, 401],
    ];
    for (const [path, status] of expected) {
      const res = await ctx.api("POST", path, {
        apiKey: null,
        rawBody: small,
        headers: { "Content-Type": "application/json" },
      });
      expectStatus(res, [status], `${path} with a small body`);
    }
  },
};
