import { sql } from "../db";
import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { expectRunOk, registerAgent, startStub } from "./script-helpers";

export const scriptParallelInlineRuns: Scenario = {
  name: "script-parallel-inline-runs",
  order: 405,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "parallel-inline");
    const intent = `parallel inline runs ${ctx.nonce}`;
    const source = `export default async function (args: { index: number; url: string }) {
  const ready = await fetch(args.url);
  if (!ready.ok) throw new Error("Parallel run barrier failed");
  return { index: args.index, marker: "${ctx.nonce}" };
}`;
    const runCount = 6;
    const ready = Promise.withResolvers<void>();
    let arrived = 0;
    // Release the scripts together so their post-run autosaves overlap.
    const stub = startStub(async () => {
      if (++arrived === runCount) ready.resolve();
      await ready.promise;
      return new Response(null, { status: 204 });
    });
    const responses = await Promise.all(
      Array.from({ length: runCount }, (_, index) =>
        ctx.api("POST", "/api/scripts/run", {
          agentId,
          body: { source, intent, args: { index, url: stub.origin }, executor: "native" },
        }),
      ),
    ).finally(() => {
      ready.resolve();
      stub.stop();
    });

    const slugs = new Set<string>();
    for (const [index, response] of responses.entries()) {
      const label = `parallel inline run ${index}`;
      expectStatus(response, [200], label);
      const run = asRecord(response.json);
      expectRunOk(run, label);
      const result = asRecord(run.result);
      expect(result.index === index && result.marker === ctx.nonce, `${label}: wrong result`);
      const autoSaved = asRecord(run.autoSaved);
      expect(autoSaved.reason === "successful_inline_run", `${label}: wrong autosave reason`);
      slugs.add(asString(autoSaved.slug, `${label} scratch slug`));
    }
    expect(slugs.size === 1, "parallel inline runs reported different scratch slugs");
    const [slug] = slugs;

    const listed = await ctx.api("GET", "/api/scripts?includeScratch=true");
    expectStatus(listed, [200], "list scratch scripts after parallel runs");
    const scripts = asRecords(listed.json, "scripts").filter(
      (script) => script.name === slug && script.scopeId === agentId,
    );
    const [scratch] = scripts;
    expect(
      scripts.length === 1 && scratch?.isScratch === true && scratch.scope === "agent",
      "expected one agent-scoped scratch script",
    );

    const scriptId = asString(scratch.id, "scratch script ID");
    const versions = await ctx.api("GET", `/api/scripts/${scriptId}/versions`);
    expectStatus(versions, [200], "list scratch script versions");
    const history = asRecords(versions.json, "versions");
    const [initialVersion] = history;
    expect(
      history.length === 1 && initialVersion?.version === 1 && initialVersion.source === source,
      "expected one version with the original inline source",
    );

    const runs = ctx.db.query<{ status: string }>(
      sql`SELECT status FROM script_runs WHERE "agentId" = ${agentId} AND kind = 'inline'`,
    );
    expect(
      runs.length === responses.length && runs.every((run) => run.status === "completed"),
      "each parallel inline run should record its own completion",
    );
  },
};
