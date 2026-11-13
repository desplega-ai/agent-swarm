// A webhook trigger with `verification.format: "hmac-sha1"` accepts senders that
// sign the raw body with HMAC-SHA1: Vercel (bare hex in x-vercel-signature) and
// GitHub's legacy X-Hub-Signature (sha1=<hex>, the default header). A tampered
// body, a SHA-256 digest, or a signature on a fallback header is rejected before
// a run is saved.
import { createHmac } from "node:crypto";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import { createWorkflow, type WorkflowDef, waitForRun } from "./workflow-helpers";

const definition: WorkflowDef = {
  nodes: [{ id: "note", type: "script", config: { runtime: "bash", script: "echo sha1" } }],
};

function runCount(ctx: ScenarioContext, workflowId: string): number {
  return Number(
    ctx.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM workflow_runs WHERE workflowId = ?", [
      workflowId,
    ])?.n ?? 0,
  );
}

export const workflowWebhookHmacSha1: Scenario = {
  name: "workflow-webhook-hmac-sha1",
  order: 323,
  async run(ctx) {
    const secret = `vercel-${ctx.nonce}`;
    const sha1 = (body: string) => createHmac("sha1", secret).update(body).digest("hex");
    const deliver = (id: string, body: string, headers: Record<string, string>) =>
      ctx.api("POST", `/api/webhooks/${id}`, {
        apiKey: null,
        rawBody: body,
        headers: { "Content-Type": "application/json", ...headers },
      });

    const vercelId = await createWorkflow(ctx, "hook-sha1-vercel", definition, {
      triggers: [
        {
          type: "webhook",
          hmacSecret: secret,
          verification: { format: "hmac-sha1", header: "x-vercel-signature" },
        },
      ],
    });

    const body = JSON.stringify({ type: "budget.reached", payload: { nonce: ctx.nonce } });
    const rejected: Array<[string, string, Record<string, string>, string]> = [
      ["a tampered body", `${body} `, { "x-vercel-signature": sha1(body) }, "Invalid signature"],
      [
        "a SHA-256 digest",
        body,
        { "x-vercel-signature": createHmac("sha256", secret).update(body).digest("hex") },
        "Invalid signature",
      ],
      ["a fallback header", body, { "x-signature": sha1(body) }, "Missing signature"],
    ];
    for (const [label, rawBody, headers, error] of rejected) {
      const res = await deliver(vercelId, rawBody, headers);
      expectStatus(res, [401], `hmac-sha1 rejects ${label}`);
      expect(asRecord(res.json).error === error, `${label} message: ${res.text}`);
    }
    expect(runCount(ctx, vercelId) === 0, "rejected deliveries write no run");

    const ok = await deliver(vercelId, body, { "x-vercel-signature": sha1(body) });
    expectStatus(ok, [201], "a Vercel-shaped bare-hex SHA-1 signature starts a run");
    const detail = await waitForRun(
      ctx,
      String(asRecord(ok.json).runId),
      "completed",
      20_000,
      "hmac-sha1 webhook run",
    );
    expect(
      asRecord(detail.run.triggerData).type === "budget.reached" &&
        asRecord(asRecord(detail.run.triggerData).payload).nonce === ctx.nonce,
      "the parsed webhook body is the run trigger data",
    );
    expect(runCount(ctx, vercelId) === 1, "the signed delivery is the only persisted run");

    const legacyId = await createWorkflow(ctx, "hook-sha1-default", definition, {
      triggers: [{ type: "webhook", hmacSecret: secret, verification: { format: "hmac-sha1" } }],
    });
    const stored = await ctx.api("GET", `/api/workflows/${legacyId}`);
    expectStatus(stored, [200], "read the hmac-sha1 workflow");
    const verification = asRecord(asRecords(stored.json, "triggers")[0]?.verification);
    expect(
      verification.format === "hmac-sha1" && verification.header === "X-Hub-Signature",
      `hmac-sha1 header defaults to X-Hub-Signature: ${stored.text}`,
    );

    const push = JSON.stringify({ action: "opened", nonce: ctx.nonce });
    const legacy = await deliver(legacyId, push, { "X-Hub-Signature": `sha1=${sha1(push)}` });
    expectStatus(legacy, [201], "a sha1=<hex> signature on the default header starts a run");
  },
};
