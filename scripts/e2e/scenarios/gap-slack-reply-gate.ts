import { drainTasks } from "../gap-helpers";
import { asRecord, expect, expectStatus, pollUntil } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  ask,
  claim,
  findSlackTask,
  finish,
  registerLead,
  waitForEyes,
  waitForOutcome,
} from "./slack-helpers";

// #2495: slack-reply-gate docs. (1) The skip probabilities sum to skipP; below minConfidence it replies; summed skip probabilities decide;
// enforce drops and mutes. (2) The "last 50 decisions" paging command returns the NEWEST rows.
// Run with: --sut-env ADDITIVE_SLACK=true --sut-env ADDITIVE_SLACK_BUFFER_MS=1500
// Decisions go to a LAYA stub (provider laya) on loopback.
const NS = "ext:slack-reply-gate";
const LABELS = [
  "direct_ask",
  "followup_to_lead",
  "instruction_to_lead",
  "reaction_only",
  "banter_between_others",
  "not_addressed_to_lead",
  "other",
];

function layaBody(choice: string, answerConfidence: number | null, probs?: Record<string, number>) {
  return {
    model: "laya-rl-agent",
    answers: {
      reason: {
        type: "choice",
        choice,
        ...(answerConfidence === null
          ? {}
          : { confidence: 0.1, answer_confidence: answerConfidence }),
        ...(probs ? { probabilities: probs } : {}),
      },
    },
    usage: { input_tokens: 10, output_tokens: 0 },
    routing: { model: "english", reason: "stub" },
  };
}
const probs = (m: Record<string, number>) => Object.fromEntries(LABELS.map((l) => [l, m[l] ?? 0]));

async function putCfg(ctx: ScenarioContext, key: string, value: string, isSecret = false) {
  expectStatus(
    await ctx.api("PUT", "/api/config", {
      body: { scope: "global", scopeId: null, key, value, isSecret },
    }),
    [200],
    `set ${key}`,
  );
}

export const gapSlackReplyGate: Scenario = {
  name: "gap-slack-reply-gate",
  order: 1150,
  async run(ctx) {
    try {
      await gapRun(ctx);
    } finally {
      await drainTasks(ctx);
    }
  },
};

async function gapRun(ctx: ScenarioContext): Promise<void> {
  // ---------- Part 2 first: paging command (independent of Slack) ----------
  const PN = "gap-paging-ns";
  const pad = (n: number) => String(n).padStart(6, "0");
  const N = 1010;
  for (let start = 0; start < N; start += 50) {
    await Promise.all(
      Array.from({ length: Math.min(50, N - start) }, (_, i) =>
        ctx.api("PUT", `/api/kv/_/${PN}/d:${pad(start + i + 1)}`, {
          body: { value: { n: start + i + 1 } },
        }),
      ),
    );
  }
  const list = async (q: string) => asRecord((await ctx.api("GET", `/api/kv/_/${PN}?${q}`)).json);
  const oldCmd = (await list("prefix=d:&limit=1000")).entries as Array<{ key: string }>;
  const oldLast50 = oldCmd.slice(-50);
  const total = Number((await list("prefix=d:&limit=1")).total);
  expect(total === N, `total ${total}, expected ${N}`);
  const newCmd = (await list(`prefix=d:&offset=${total > 50 ? total - 50 : 0}&limit=50`))
    .entries as Array<{ key: string }>;
  expect(
    newCmd.length === 50 &&
      newCmd[49].key === `d:${pad(N)}` &&
      newCmd[0].key === `d:${pad(N - 49)}`,
    `docs command did not end on the newest row: ${newCmd[0]?.key}..${newCmd[newCmd.length - 1]?.key}`,
  );
  expect(
    oldLast50[49].key !== `d:${pad(N)}`,
    "control: old command unexpectedly reached the newest row",
  );
  ctx.log(
    `paging: old command ends at ${oldLast50[49].key}, docs command ends at ${newCmd[49].key} of ${N}`,
  );

  // ---------- Part 1: gate decisions through a LAYA stub ----------
  const seen: string[] = [];
  const stub = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const raw = await req.text();
      seen.push(raw.slice(0, 2000));
      // Match the new message only: older markers sit in recent_thread_messages.
      const text = String(
        (JSON.parse(raw) as { state?: { new_message?: string } }).state?.new_message ?? "",
      );
      // The server requires `probabilities` on every choice answer, so a null skipP cannot be produced.
      if (text.includes("NOPROBS")) return Response.json(layaBody("banter_between_others", 0.9));
      if (text.includes("BANTER90"))
        return Response.json(
          layaBody(
            "banter_between_others",
            0.9,
            probs({ banter_between_others: 0.9, direct_ask: 0.1 }),
          ),
        );
      if (text.includes("BANTER30"))
        return Response.json(
          layaBody(
            "banter_between_others",
            0.4,
            probs({ banter_between_others: 0.4, followup_to_lead: 0.35, other: 0.25 }),
          ),
        );
      if (text.includes("SPLIT"))
        return Response.json(
          layaBody(
            "reaction_only",
            0.5,
            probs({
              reaction_only: 0.3,
              banter_between_others: 0.3,
              not_addressed_to_lead: 0.1,
              direct_ask: 0.3,
            }),
          ),
        );
      return Response.json(layaBody("direct_ask", 0.95, probs({ direct_ask: 0.95, other: 0.05 })));
    },
  });
  try {
    await putCfg(ctx, "LAYA_URL", `http://127.0.0.1:${stub.port}`);
    await putCfg(ctx, "LAYA_API_KEY", ["laya", "stub", ctx.nonce].join("-"), true);
    const inst = await ctx.api("POST", "/api/extensions/install", {
      body: {
        template: "slack-reply-gate",
        config: { mode: "shadow", provider: "laya", minConfidence: 0.55 },
      },
    });
    expectStatus(inst, [200], "install slack-reply-gate");
    const extId = String(asRecord(asRecord(inst.json).extension).id);
    expectStatus(
      await ctx.api("POST", `/api/extensions/${extId}/enable`),
      [200],
      "enable slack-reply-gate",
    );

    let leadId = await registerLead(ctx, "e2e-lead-gap-gate");
    const root = await ask(ctx, "open a thread for the gate");
    await waitForEyes(ctx, root.ts);
    const rootTask = await findSlackTask(ctx, root.ts);
    leadId = String(rootTask.agentId);
    await claim(ctx, leadId, String(rootTask.id));
    await finish(ctx, leadId, String(rootTask.id), {
      status: "completed",
      output: "Gate thread ready.",
    });
    await waitForOutcome(ctx, root.ts, "Gate thread ready.");

    const kv = async (key: string) => {
      const r = await ctx.api("GET", `/api/kv/_/${NS}/${key}`);
      return r.status === 200
        ? (asRecord(asRecord(r.json).value) as Record<string, unknown>)
        : null;
    };
    const settleNew = async (): Promise<void> => {
      // Complete any Lead task the flush created so the next probe starts clean.
      const r = await ctx.api("GET", `/api/tasks?agentId=${leadId}&fields=full&limit=50`);
      for (const t of (asRecord(r.json).tasks as unknown[]).map(asRecord)) {
        if (t.status === "pending") await claim(ctx, leadId, String(t.id)).catch(() => {});
        const cur = asRecord((await ctx.api("GET", `/api/tasks/${t.id}`)).json).status;
        if (cur === "in_progress")
          await finish(ctx, leadId, String(t.id), { status: "completed", output: "ack" }).catch(
            () => {},
          );
      }
    };
    // Posts an unmentioned thread reply and returns the decision row it produced.
    const probe = async (marker: string): Promise<{ row: Record<string, unknown>; ts: string }> => {
      const msg = await ctx.slack.postMessage({
        channel: "general",
        user: "alice",
        text: `${marker} just chatting`,
        thread_ts: root.ts,
      });
      const ok = await pollUntil(
        async () => {
          const last = await kv("last");
          return !!last && last.triggerTs === msg.ts;
        },
        25_000,
        500,
      );
      expect(
        ok,
        `no decision row for ${marker} (stub saw ${seen.length} calls; last=${JSON.stringify(await kv("last"))}; stub0=${seen[0]?.slice(0, 600)})`,
      );
      return { row: (await kv("last")) as Record<string, unknown>, ts: msg.ts };
    };

    // Shadow mode.
    const b90 = await probe("BANTER90");
    expect(
      b90.row.action === "shadow-skip" &&
        b90.row.reason === "banter_between_others" &&
        Math.abs(Number(b90.row.skipP) - 0.9) < 1e-9 &&
        b90.row.provider === "laya",
      `no-probabilities skip: ${JSON.stringify(b90.row)}`,
    );
    await settleNew();
    const b30 = await probe("BANTER30");
    expect(
      b30.row.action === "pass" &&
        b30.row.lowConfidence === true &&
        Math.abs(Number(b30.row.skipP) - 0.4) < 1e-9,
      `low-confidence skip label did not reply: ${JSON.stringify(b30.row)}`,
    );
    await settleNew();
    const split = await probe("SPLIT");
    expect(
      split.row.action === "shadow-skip" && Math.abs(Number(split.row.skipP) - 0.7) < 1e-9,
      `split skip labels: ${JSON.stringify(split.row)}`,
    );
    await settleNew();
    const ask1 = await probe("DIRECT");
    expect(
      ask1.row.action === "pass" && ask1.row.reason === "direct_ask",
      `direct_ask: ${JSON.stringify(ask1.row)}`,
    );
    await settleNew();
    // The "no probabilities" path the docs describe (null skipP) is unreachable through the server: it rejects the answer and the gate fails open.
    const noprobs = await probe("NOPROBS");
    expect(
      noprobs.row.action === "fail-open" &&
        String(noprobs.row.error).includes("probabilities must be an object"),
      `answer without probabilities: ${JSON.stringify(noprobs.row)}`,
    );
    await settleNew();

    // Enforce mode: drop + :mute: for BANTER90, still replies for BANTER30.
    expectStatus(
      await ctx.api("PATCH", `/api/extensions/${extId}`, {
        body: { config: { mode: "enforce", provider: "laya", minConfidence: 0.55 } },
      }),
      [200],
      "switch to enforce",
    );
    await Bun.sleep(1500);
    const tasksBefore = asRecord(
      (await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100")).json,
    ).tasks as unknown[];
    const dropped = await probe("BANTER90 enforce");
    expect(
      dropped.row.action === "skipped",
      `enforce did not skip: ${JSON.stringify(dropped.row)}`,
    );
    // The hook posts :mute: to https://slack.com/api (hardcoded, not the mock), with the mock's fake
    // bot token: Slack rejects it, so the attempt shows up as a `mute-error` row, not a reaction.
    const muteRow = await pollUntil(async () => {
      const r = await ctx.api("GET", `/api/kv/_/${NS}?prefix=m:&limit=50`);
      return ((asRecord(r.json).entries as unknown[]) ?? []).length > 0;
    }, 20_000);
    expect(muteRow, "enforce drop left no m: mute-attempt row");
    const mrows = (
      asRecord((await ctx.api("GET", `/api/kv/_/${NS}?prefix=m:&limit=50`)).json).entries as Array<{
        value: Record<string, unknown>;
      }>
    ).map((e) => e.value);
    ctx.log(`mute attempt: ${JSON.stringify(mrows[0]).slice(0, 200)}`);
    const tasksAfter = asRecord(
      (await ctx.api("GET", "/api/tasks?source=slack&fields=full&limit=100")).json,
    ).tasks as unknown[];
    expect(
      tasksAfter.length === tasksBefore.length,
      `enforce drop still created a task (${tasksBefore.length} -> ${tasksAfter.length})`,
    );
    const passed = await probe("BANTER30 enforce");
    expect(
      passed.row.action === "pass",
      `enforce low-confidence did not reply: ${JSON.stringify(passed.row)}`,
    );
    const mcount = (
      (asRecord((await ctx.api("GET", `/api/kv/_/${NS}?prefix=m:&limit=50`)).json)
        .entries as unknown[]) ?? []
    ).length;
    expect(mcount === mrows.length, "a replied message got a mute attempt");
    await settleNew();

    expectStatus(await ctx.api("POST", `/api/extensions/${extId}/disable`), [200], "disable");
    expectStatus(await ctx.api("DELETE", `/api/extensions/${extId}`), [200], "uninstall");
  } finally {
    stub.stop(true);
  }
}
