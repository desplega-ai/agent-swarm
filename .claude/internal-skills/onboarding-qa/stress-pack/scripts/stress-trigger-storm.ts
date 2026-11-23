// Duplicate triggers: fire one workflow many times at once with repeated
// idempotency keys. The number of runs must equal the number of distinct keys.
// Then the signed webhook route: no key, so every delivery is its own run.
type StormArgs = { webhookSecret?: string };

async function hmacHex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return [...sig].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export default async function (args: StormArgs | undefined, ctx: ScriptContext) {
  return stressRun(ctx, "trigger-storm", async (t, env) => {
    const listed = (await ctx.swarm.workflow_list({})) as Sdk;
    const all: Any[] = Array.isArray(listed.data) ? listed.data : (listed.data?.workflows ?? []);
    const target = all.find((item) => item.name === "stress-dedup");
    if (!t.ok("target-workflow-exists", target?.id, { listStatus: listed.status })) return {};
    const id = String(target.id);
    const storm = env.id;
    const keys = Array.from({ length: 5 * env.level }, (_, i) => `k${i}`);
    const repeats = 4;
    const hits = async (key: string) =>
      Number((await kvValue(ctx, `stress/storm/${storm}/hits/${key}`)) ?? 0);

    // 1. Every key, `repeats` times, all at once.
    const shots = keys.flatMap((key) => Array.from({ length: repeats }, () => key));
    const fired = await Promise.all(
      shots.map(async (key) => {
        const res = (await ctx.swarm.workflow_trigger({
          id,
          wait: false,
          idempotencyKey: `stress-${storm}-${key}`,
          triggerData: { storm, key },
        })) as Sdk;
        return { key, status: res.status, runId: res.data?.runId as string | undefined };
      }),
    );
    const refused = fired.filter((f) => f.status !== 201 || !f.runId);
    t.ok("every-trigger-answers-201-with-a-run-id", refused.length === 0, refused.slice(0, 3));
    const runIds = new Set(fired.map((f) => f.runId).filter(Boolean));
    t.ok("runs-equal-distinct-keys", runIds.size === keys.length, {
      runs: runIds.size,
      keys: keys.length,
      shots: shots.length,
    });
    const splitKeys = keys.filter(
      (key) => new Set(fired.filter((f) => f.key === key).map((f) => f.runId)).size !== 1,
    );
    t.ok("one-run-id-per-key", splitKeys.length === 0, splitKeys);

    // 2. A used key with a different body is a conflict, and starts nothing.
    const conflict = (await ctx.swarm.workflow_trigger({
      id,
      wait: false,
      idempotencyKey: `stress-${storm}-k0`,
      triggerData: { storm, key: "k0", changed: true },
    })) as Sdk;
    t.ok("same-key-different-body-is-409", conflict.status === 409, {
      status: conflict.status,
      body: JSON.stringify(conflict.data).slice(0, 160),
    });

    // 3. Each key's run did its work exactly once.
    let counts: number[] = [];
    for (let attempt = 0; attempt < 6; attempt++) {
      await sleep(1000);
      counts = await Promise.all(keys.map(hits));
      if (counts.every((count) => count >= 1)) break;
    }
    t.ok(
      "each-key-ran-exactly-once",
      counts.every((count) => count === 1),
      { counts },
    );

    // 4. The webhook route, with an HMAC signature and no idempotency key.
    let deliveries = 0;
    if (args?.webhookSecret) {
      const base = ctx.stdlib.Redacted.value(ctx.swarm.config.mcpBaseUrl).replace(/\/$/, "");
      const hookKeys = Array.from({ length: 3 * env.level }, (_, i) => `w${i}`);
      deliveries = hookKeys.length;
      const post = async (body: string, signature: string) => {
        const res = await ctx.stdlib.fetch(`${base}/api/webhooks/${id}`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-Hub-Signature-256": signature },
          body,
          retry: false,
        });
        return { status: res.status, text: (await res.text()).slice(0, 200) };
      };
      const delivered = await Promise.all(
        hookKeys.map(async (key) => {
          const body = JSON.stringify({ storm, key });
          return post(body, `sha256=${await hmacHex(args.webhookSecret as string, body)}`);
        }),
      );
      t.ok(
        "signed-webhook-deliveries-are-accepted",
        delivered.every((d) => d.status >= 200 && d.status < 300),
        delivered.slice(0, 3),
      );
      const forged = await post(
        JSON.stringify({ storm, key: "forged" }),
        `sha256=${"0".repeat(64)}`,
      );
      t.ok("bad-signature-is-401", forged.status === 401, forged);
      const unsigned = await ctx.stdlib.fetch(`${base}/api/webhooks/${id}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storm, key: "unsigned" }),
        retry: false,
      });
      t.ok("missing-signature-is-401", unsigned.status === 401, { status: unsigned.status });

      let hookCounts: number[] = [];
      for (let attempt = 0; attempt < 6; attempt++) {
        await sleep(1000);
        hookCounts = await Promise.all(hookKeys.map(hits));
        if (hookCounts.every((count) => count >= 1)) break;
      }
      t.ok(
        "each-webhook-delivery-ran-exactly-once",
        hookCounts.every((count) => count === 1),
        { hookCounts },
      );
      t.ok(
        "refused-deliveries-started-no-run",
        (await hits("forged")) === 0 && (await hits("unsigned")) === 0,
        { forged: await hits("forged"), unsigned: await hits("unsigned") },
      );
    }

    return { keys: keys.length, shots: shots.length, runs: runIds.size, deliveries };
  });
}
