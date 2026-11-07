import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";

type ScratchRow = { isScratch: number; typeChecked: number; scopeId: string | null };
type RunRow = { status: string; kind: string; scriptName: string | null; error: string | null };

/**
 * Flow `script-inline-run`: POST /api/scripts/run with inline source (the `(args, ctx)`
 * signature), the result envelope, the auto-saved scratch script on success only, the
 * persisted inline run row, KV persistence through idempotencyKey, and the script-run MCP tool.
 */
export const scriptInlineRun: Scenario = {
  name: "script-inline-run",
  order: 400,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "inline");
    const marker = `inline-${ctx.nonce}`;
    const intent = `e2e inline double ${ctx.nonce}`;

    // ── success: result, stdout, ctx shape, auto-saved scratch script ──
    const source = `export default async function (args: { n: number; marker: string }, ctx: any) {
  console.log("log " + args.marker);
  return { doubled: args.n * 2, marker: args.marker, ctxKeys: Object.keys(ctx).sort() };
}`;
    const run = await runScript(ctx, agentId, { source, args: { n: 21, marker }, intent });
    expectRunOk(run, "inline run");
    const result = asRecord(run.result);
    expect(result.doubled === 42 && result.marker === marker, "inline result is wrong");
    expect(
      JSON.stringify(result.ctxKeys) ===
        JSON.stringify(["api", "fs", "logger", "mcp", "sh", "stdlib", "swarm"]),
      `ctx offers an unexpected surface: ${JSON.stringify(result.ctxKeys)}`,
    );
    expect(
      typeof run.stdout === "string" && run.stdout.includes(`log ${marker}`),
      "inline run did not capture stdout",
    );
    expect(run.stderr === "", "clean run wrote to stderr");
    expect(typeof run.durationMs === "number" && run.durationMs >= 0, "no durationMs");
    expect(
      JSON.stringify(run.truncated) === JSON.stringify({ stdout: false, stderr: false }),
      "small output must not be truncated",
    );
    const autoSaved = asRecord(run.autoSaved);
    const slug = String(autoSaved.slug);
    expect(autoSaved.reason === "successful_inline_run", "autoSaved reason is wrong");
    expect(slug.startsWith("scratch-e2e-inline-double-"), `scratch slug is wrong: ${slug}`);
    expect(run.kvSaved === undefined, "kvSaved appeared without an idempotencyKey");

    // ── the scratch script is hidden by default, listed with includeScratch ──
    const hidden = await ctx.api("GET", "/api/scripts");
    expectStatus(hidden, [200], "list scripts");
    expect(
      !asRecords(hidden.json, "scripts").some((script) => script.name === slug),
      "scratch script leaked into the default script list",
    );
    const listed = await ctx.api("GET", "/api/scripts?includeScratch=true");
    expectStatus(listed, [200], "list scripts with scratch");
    const scratch = asRecords(listed.json, "scripts").find((script) => script.name === slug);
    expect(scratch, "auto-saved scratch script missing from includeScratch list");
    expect(
      scratch.isScratch === true &&
        scratch.scope === "agent" &&
        scratch.scopeId === agentId &&
        scratch.typeChecked === false &&
        scratch.version === 1,
      `scratch script metadata is wrong: ${JSON.stringify(scratch)}`,
    );
    const row = ctx.db.get<ScratchRow>(
      "SELECT isScratch, typeChecked, scopeId FROM scripts WHERE name = ?",
      [slug],
    );
    expect(
      row?.isScratch === 1 && row.typeChecked === 0 && row.scopeId === agentId,
      "scratch script row is not persisted as scratch",
    );

    // ── the same source again reuses the scratch script instead of adding another ──
    const again = await runScript(ctx, agentId, { source, args: { n: 1, marker }, intent });
    expect(asRecord(again.autoSaved).slug === slug, "same source must map to the same slug");
    const count = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM scripts WHERE name = ?", [
      slug,
    ]);
    expect(count?.n === 1, "re-running the same inline source duplicated the scratch script");

    // ── a scratch script runs by name ──
    const named = await runScript(ctx, agentId, { name: slug, args: { n: 5, marker } });
    expectRunOk(named, "scratch run by name");
    expect(asRecord(named.result).doubled === 10, "scratch script did not run by name");

    // ── every inline run lands in the Script Runs list as an inline run ──
    const inlineRuns = ctx.db.query<RunRow>(
      "SELECT status, kind, scriptName, error FROM script_runs WHERE agentId = ? AND kind = 'inline'",
      [agentId],
    );
    expect(
      inlineRuns.length >= 3 && inlineRuns.every((entry) => entry.status === "completed"),
      `inline runs were not recorded: ${JSON.stringify(inlineRuns)}`,
    );
    expect(
      inlineRuns.some((entry) => entry.scriptName === "(inline source)") &&
        inlineRuns.some((entry) => entry.scriptName === slug),
      "inline run rows must carry the source label or the script name",
    );

    // ── idempotencyKey persists the output to KV on success ──
    const idemKey = `e2e-idem-${ctx.nonce}`;
    const keyed = await runScript(ctx, agentId, {
      source: `export default async function () { return { kept: "${marker}" }; }`,
      idempotencyKey: idemKey,
      intent: `e2e keyed ${ctx.nonce}`,
    });
    expect(
      JSON.stringify(keyed.kvSaved) ===
        JSON.stringify({ namespace: "script:executions", key: idemKey }),
      `kvSaved is wrong: ${JSON.stringify(keyed.kvSaved)}`,
    );
    const kv = await ctx.api("GET", `/api/kv/_/script:executions/${idemKey}`);
    expectStatus(kv, [200], "read idempotent output from KV");
    const kvValue = asRecord(asRecord(kv.json).value);
    expect(asRecord(kvValue.result).kept === marker, "KV output does not hold the run result");
    expect(typeof kvValue.executedAt === "string", "KV output has no executedAt");

    // ── failures are HTTP 200 with the error in the envelope, never auto-saved ──
    const failIntent = `e2e failing ${ctx.nonce}`;
    const thrown = await runScript(ctx, agentId, {
      source: `export default async function () { throw new Error("boom-${marker}"); }`,
      intent: failIntent,
      idempotencyKey: `e2e-idem-fail-${ctx.nonce}`,
    });
    const thrownError = asRecord(thrown.runtimeError);
    expect(thrown.exitCode === 1 && thrown.error === "eval_error", "thrown run must be eval_error");
    expect(thrownError.message === `boom-${marker}`, "runtimeError.message lost the error text");
    expect(
      typeof thrown.stderr === "string" && thrown.stderr.includes(`boom-${marker}`),
      "stderr lost the error text",
    );
    expect(
      thrown.autoSaved === undefined && thrown.kvSaved === undefined,
      "a failed run must not auto-save or persist to KV",
    );
    const failedScratch = await ctx.api("GET", "/api/scripts?includeScratch=true");
    expect(
      !asRecords(failedScratch.json, "scripts").some((script) => script.intent === failIntent),
      "a failed inline run created a scratch script",
    );
    const failedKv = await ctx.api("GET", `/api/kv/_/script:executions/e2e-idem-fail-${ctx.nonce}`);
    expectStatus(failedKv, [404], "failed run must not write KV");
    const failedRow = ctx.db.get<RunRow>(
      "SELECT status, kind, scriptName, error FROM script_runs WHERE agentId = ? AND status = 'failed' AND kind = 'inline'",
      [agentId],
    );
    expect(
      failedRow?.error?.includes("eval_error") && failedRow.error.includes(`boom-${marker}`),
      `failed inline run row lost the error: ${JSON.stringify(failedRow)}`,
    );

    const syntax = await runScript(ctx, agentId, {
      source: "export default async function ( { return 1 ",
    });
    expect(
      syntax.exitCode === 1 && syntax.error === "eval_error",
      "syntax error must fail the run",
    );
    const noDefault = await runScript(ctx, agentId, { source: "export const value = 1;" });
    expect(
      noDefault.error === "eval_error" &&
        String(asRecord(noDefault.runtimeError).message).includes("export default"),
      "a script without a default export must explain the signature",
    );
    const imported = await runScript(ctx, agentId, {
      source: `import fs from "node:fs"; export default async function () { return typeof fs; }`,
    });
    expect(
      imported.error === "import_violation" &&
        String(imported.stderr).includes("not allowed in swarm scripts"),
      "a disallowed import must fail with import_violation",
    );
    const exited = await runScript(ctx, agentId, {
      source: "export default async function () { process.exit(3); }",
    });
    expect(exited.exitCode === 3 && exited.error === "eval_error", "process.exit must surface");

    // ── validation and identity ──
    const trivial = "export default async function () { return 1; }";
    const neither = await ctx.api("POST", "/api/scripts/run", { agentId, body: {} });
    expectStatus(neither, [400], "neither name nor source");
    const both = await ctx.api("POST", "/api/scripts/run", {
      agentId,
      body: { name: slug, source: trivial },
    });
    expectStatus(both, [400], "both name and source");
    const missing = await ctx.api("POST", "/api/scripts/run", {
      agentId,
      body: { name: `no-such-script-${ctx.nonce}` },
    });
    expectStatus(missing, [404], "missing named script");
    const noAgent = await ctx.api("POST", "/api/scripts/run", { body: { source: trivial } });
    expectStatus(noAgent, [400], "run without X-Agent-ID");
    const unknownAgent = await ctx.api("POST", "/api/scripts/run", {
      agentId: `no-such-agent-${ctx.nonce}`,
      body: { source: trivial },
    });
    expectStatus(unknownAgent, [404], "run as an unknown agent");
    const noKey = await ctx.api("POST", "/api/scripts/run", {
      apiKey: null,
      agentId,
      body: { source: trivial },
    });
    expectStatus(noKey, [401], "run without an API key");
    const badExecutor = await ctx.api("POST", "/api/scripts/run", {
      agentId,
      body: { source: trivial, executor: "wasm" },
    });
    expectStatus(badExecutor, [400], "unknown executor");

    // ── a source with an embedded secret is refused before it runs or persists ──
    const secretIntent = `e2e secret ${ctx.nonce}`;
    const token = ["ghp", "aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5"].join("_");
    const refused = await ctx.api("POST", "/api/scripts/run", {
      agentId,
      body: {
        source: `export default async function () { return "${token}"; }`,
        intent: secretIntent,
      },
    });
    expectStatus(refused, [400], "inline source with a secret");
    const refusal = asRecord(refused.json);
    expect(refusal.error === "source_contains_secret", "secret refusal has the wrong error code");
    expect(!refused.text.includes(token), "the refusal echoed the secret value");
    const afterRefusal = await ctx.api("GET", "/api/scripts?includeScratch=true");
    expect(
      !asRecords(afterRefusal.json, "scripts").some((script) => script.intent === secretIntent),
      "a refused source was saved as a scratch script",
    );

    // ── MCP script-run: inline, named, failing ──
    await withMcp(ctx, agentId, async (mcp) => {
      const inline = await callToolOk(mcp, "script-run", {
        source: `export default async function (args: { v: number }) { return { v: args.v + 1 }; }`,
        args: { v: 1 },
        intent: `e2e mcp inline ${ctx.nonce}`,
      });
      const inlineData = asRecord(structured(inline).data);
      expect(asRecord(inlineData.result).v === 2, "script-run tool returned the wrong result");
      expect(
        String(asRecord(inlineData.autoSaved).slug).startsWith("scratch-e2e-mcp-inline-"),
        "script-run tool did not auto-save the inline script",
      );
      expect(toolText(inline).includes("auto-saved as scratch script"), "tool text lost the note");

      const byName = await callToolOk(mcp, "script-run", { name: slug, args: { n: 6, marker } });
      expect(
        asRecord(asRecord(structured(byName).data).result).doubled === 12,
        "script-run tool did not run the scratch script by name",
      );

      const failing = await callToolErr(mcp, "script-run", {
        source: `export default async function () { throw new Error("mcp-${marker}"); }`,
      });
      expect(toolText(failing).includes(`mcp-${marker}`), "failing script-run lost the error text");
      expect(structured(failing).success === false, "failing script-run must report success=false");

      const unknown = await callToolErr(mcp, "script-run", { name: `no-such-${ctx.nonce}` });
      expect(toolText(unknown).includes("Script not found"), "unknown script-run name lost 404");
    });
  },
};
