import { asRecord, asString, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import { expectRunOk, getLead, registerAgent, upsertScript } from "./script-helpers";

export const scriptRunnerCapacity: Scenario = {
  name: "script-runner-capacity",
  order: 496,
  async run(ctx) {
    const keys = ["SCRIPT_EMBEDDED_RUNNER_SLOTS", "SCRIPT_QUEUE_WAIT_SYNC_MS"];
    const config = (key: string, value: string) =>
      ctx.api("PUT", "/api/config", { body: { scope: "global", key, value } });
    if (ctx.db.engine === "sqlite") {
      for (const key of keys) {
        const refused = await config(key, "0");
        expectStatus(refused, [400], "SQLite capacity refusal");
        expect(refused.text.includes("script_runners_need_postgres"), "engine error");
        let bootRefused = false;
        try {
          await ctx.restartSut({ env: { [key]: "0" } });
        } catch (error) {
          const message = String(error);
          expect(
            message.includes("script_runners_need_postgres") && message.includes(key),
            `boot refusal: ${message}`,
          );
          bootRefused = true;
        } finally {
          await ctx.restartSut();
        }
        expect(bootRefused, `SQLite boot must refuse ${key}`);
      }
      return;
    }
    const agentId = await registerAgent(ctx, "capacity");
    const leadId = await getLead(ctx);
    const lane = async () =>
      asRecord(asRecord(asRecord((await ctx.api("GET", "/api/script-runners")).json).lanes).sync);
    const invoke = async (body: Record<string, unknown>) => {
      const response = await ctx.api("POST", "/api/scripts/run", {
        agentId,
        body,
        timeoutMs: 90000,
      });
      expectStatus(response, [200], "capacity script run");
      return asRecord(response.json);
    };
    let runIndex = 0;
    const run = (ms: number, executor = "quickjs") =>
      invoke({
        executor,
        source: `// capacity-${ctx.nonce}-${runIndex++}\nexport default async () => { await new Promise(r => setTimeout(r, ${ms})); return 42; }`,
      });
    const defaults = Array.from({ length: 50 }, () => run(1000));
    expect(
      await pollUntil(async () => (await lane()).inFlight === 50, 10000, 10),
      "50 default runs admitted",
    );
    expect((await lane()).queued === 0 && (await lane()).slots === null, "unbounded default");
    for (const result of await Promise.all(defaults)) expectRunOk(result, "default run");
    expectStatus(await config(keys[1]!, "-1"), [400], "negative queue wait");
    expectStatus(await config(keys[1]!, "600000"), [400], "token lifetime bound");
    await ctx.restartSut({
      env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0", SCRIPT_QUEUE_WAIT_SYNC_MS: "60000" },
    });
    const minted = asRecord(
      (
        await ctx.api("POST", "/api/script-runners/credentials", {
          body: { name: `capacity-${ctx.nonce}` },
        })
      ).json,
    );
    const credentialId = asString(asRecord(minted.credential).id, "credential");
    const runner = ctx.startScriptRunner(asString(minted.token, "token"), 2);
    const observations: number[] = [];
    try {
      expect(
        await pollUntil(async () => (await lane()).slots === 2, 15000, 50),
        "two slots connected",
      );
      const batch = Array.from({ length: 6 }, () => run(1000));
      expect(
        await pollUntil(
          async () => {
            const metric = await lane();
            observations.push(Number(metric.queued));
            expect(Number(metric.inFlight) <= 2, "slot cap");
            return metric.queued === 4;
          },
          10000,
          10,
        ),
        "four queued",
      );
      for (const result of await Promise.all(batch)) expectRunOk(result, "queued run");
      observations.push(Number((await lane()).queued));
      expect(observations.at(-1) === 0, "queue drained");
      ctx.log(`Queue observations: ${JSON.stringify(observations)}`);
      // Hold both slots beyond the original 40-second object lease.
      const object = await upsertScript(ctx, leadId, {
        name: `lease-${ctx.nonce}`,
        scope: "global",
        executor: "quickjs",
        source:
          'import { DurableObject } from "swarm-sdk"; export default class Counter extends DurableObject<{n:number}> { initialState(){return {n:0}} add(){return ++this.state.n} }',
      });
      const holders = Array.from({ length: 4 }, () => run(21000));
      expect(
        await pollUntil(
          async () => (await lane()).inFlight === 2 && (await lane()).queued === 2,
          10000,
          20,
        ),
        "lease blockers started",
      );
      const queueStarted = Date.now();
      const durable = invoke({
        name: `lease-${ctx.nonce}`,
        scope: "global",
        object: { id: "queued", method: "add" },
      });
      expect(
        await pollUntil(async () => (await lane()).queued === 3, 5000, 20),
        "object waits in sync queue",
      );
      const result = await durable;
      expectRunOk(result, `queued durable object ${object.id}`);
      const objectWaitMs = Date.now() - queueStarted;
      expect(objectWaitMs > 40000, "object waited beyond the original lease");
      ctx.log(`Durable object completed after ${objectWaitMs} ms with state committed`);
      expect(result.result === 1, "object state committed after queue wait");
      await Promise.all(holders);
      await ctx.restartSut({
        env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0", SCRIPT_QUEUE_WAIT_SYNC_MS: "100" },
      });
      expect(
        await pollUntil(async () => (await lane()).slots === 2, 15000, 50),
        "runner reconnected",
      );
      const busy = [run(1500), run(1500)];
      expect(
        await pollUntil(async () => (await lane()).inFlight === 2, 5000, 10),
        "timeout blockers started",
      );
      const timedOut = await run(1);
      expect(timedOut.error === "capacity_exceeded", "queue wait exceeded");
      expect(
        asRecord(timedOut.runtimeError).message?.toString().includes("sync script queue"),
        "queue named in error",
      );
      await Promise.all(busy);
      expect(
        (await lane()).queued === 0 && (await lane()).inFlight === 0,
        "timeout counters cleared",
      );
      await ctx.restartSut({ env: { SCRIPT_EMBEDDED_RUNNER_SLOTS: "0" } });
      expect(
        await pollUntil(async () => (await lane()).slots === 2, 15000, 50),
        "runner reconnect for abort",
      );
      const blocking = [run(1500), run(1500)];
      expect(
        await pollUntil(async () => (await lane()).inFlight === 2, 5000, 10),
        "abort blockers started",
      );
      const abort = new AbortController();
      const request = fetch(`${ctx.baseUrl}/api/scripts/run`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${ctx.apiKey}`,
          "X-Agent-ID": agentId,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ source: "export default () => 7" }),
        signal: abort.signal,
      }).catch(() => null);
      expect(
        await pollUntil(async () => (await lane()).queued === 1, 5000, 10),
        "abort request queued",
      );
      abort.abort();
      await request;
      expect(
        await pollUntil(async () => (await lane()).queued === 0, 5000, 10),
        "abort removes queued request",
      );
      await Promise.all(blocking);
    } finally {
      await runner.stop();
      await ctx.api("DELETE", `/api/script-runners/credentials/${credentialId}`);
      await ctx.restartSut();
    }
  },
};
