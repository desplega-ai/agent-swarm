import { asRecord, expect } from "../http";
import type { Scenario } from "../run";
import { expectRunOk, registerAgent, runScript } from "./script-helpers";

const EXECUTORS = ["native", "quickjs"] as const;

/** A method name far longer than any tool: the suggestion lookup must not scale with it. */
const LONG_NAME_LENGTH = 20_000;
/** Before the length bound, a 20k-char name spent about 2 s in suggestion search on the host. */
const LONG_NAME_BUDGET_MS = 500;

const TOOL_ERRORS_SCRIPT = `import { SwarmToolError, SWARM_TOOL_ERROR_CODES } from "swarm-sdk";
const LONG_NAME_LENGTH = ${LONG_NAME_LENGTH};
export default async function (args: { missing: string }, ctx: any) {
  const probe = async (call: () => Promise<unknown>) => {
    try {
      await call();
      return "resolved";
    } catch (error: any) {
      return {
        name: error.name,
        code: error.code,
        tool: error.tool,
        status: error.status ?? null,
        suggestions: error.suggestions ?? null,
        message: error.message,
        isInstance: error instanceof SwarmToolError && error instanceof Error,
        is: SwarmToolError.is(error),
      };
    }
  };
  const timed = async (call: () => Promise<unknown>) => {
    const started = Date.now();
    const result = await call();
    return { result, ms: Date.now() - started };
  };
  return {
    codes: SWARM_TOOL_ERROR_CODES,
    typo: await probe(() => ctx.swarm.db_qeury({ sql: "select 1" })),
    respelled: await probe(() => ctx.swarm["kv-get-or-null"]({ key: "x" })),
    camel: await probe(() => ctx.swarm.storeProgress({})),
    noMatch: await probe(() => ctx.swarm.zzqxwv({})),
    notExposed: await probe(() => ctx.swarm.get_oauth_access_token({})),
    invalidArgs: await probe(() => ctx.swarm.kv_get({})),
    notFound: await probe(() => ctx.swarm.script_run({ name: args.missing, args: {} })),
    refused: await probe(() => ctx.objects.get({ id: args.missing })),
    sqlError: await probe(() => ctx.db.query("SELECT * FROM no_such_table_" + args.missing.replace(/\\W/g, "_"))),
    nullSql: await probe(() => ctx.db.query(null)),
    badSql: await probe(() => ctx.db.query({ sqlite: "select 1" })),
    longName: await timed(() => probe(() => ctx.swarm["x".repeat(LONG_NAME_LENGTH)]({}))),
  };
}`;

type Probe = Record<string, unknown>;

/**
 * Flow `script-sdk-calls`: a failed ctx.swarm, ctx.<namespace> or ctx.db.query call throws a
 * SwarmToolError with the same code, tool and status on both executors. An unknown
 * ctx.swarm method names the closest exposed ones, a deliberately excluded tool keeps its
 * "not exposed" error, and the class imported from swarm-sdk matches with instanceof.
 */
export const scriptToolErrors: Scenario = {
  name: "script-tool-errors",
  order: 482,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "tool-errors");
    for (const executor of EXECUTORS) {
      const label = `tool errors (${executor})`;
      const run = await runScript(ctx, agentId, {
        source: TOOL_ERRORS_SCRIPT,
        args: { missing: `e2e-missing-${ctx.nonce}` },
        executor,
        intent: `e2e tool errors ${executor} ${ctx.nonce}`,
      });
      expectRunOk(run, label);
      const out = asRecord(run.result);
      const probe = (key: string): Probe => {
        const value = asRecord(out[key]);
        expect(
          value.name === "SwarmToolError" && value.isInstance === true && value.is === true,
          `${label}: ${key} must throw a SwarmToolError instance: ${JSON.stringify(out[key])}`,
        );
        return value;
      };
      const show = (key: string) => `${label}: ${key}: ${JSON.stringify(out[key])}`;

      expect(
        Array.isArray(out.codes) && out.codes.includes("unknown_tool"),
        `${label}: SWARM_TOOL_ERROR_CODES must be exported: ${JSON.stringify(out.codes)}`,
      );

      const typo = probe("typo");
      expect(
        typo.code === "unknown_tool" &&
          typo.tool === "db_qeury" &&
          JSON.stringify(typo.suggestions) === JSON.stringify(["db_query"]) &&
          String(typo.message).startsWith("Tool 'db_qeury' is not exposed to scripts") &&
          String(typo.message).includes("Did you mean ctx.swarm.db_query?"),
        show("typo"),
      );
      const respelled = probe("respelled");
      expect(
        respelled.code === "unknown_tool" &&
          JSON.stringify(respelled.suggestions) === JSON.stringify(["kv_getOrNull"]),
        show("respelled"),
      );
      const camel = probe("camel");
      expect(
        camel.code === "unknown_tool" &&
          JSON.stringify(camel.suggestions) === JSON.stringify(["task_storeProgress"]),
        show("camel"),
      );
      const noMatch = probe("noMatch");
      expect(
        noMatch.code === "unknown_tool" &&
          JSON.stringify(noMatch.suggestions) === "[]" &&
          String(noMatch.message).includes("No exposed tool has a similar name"),
        show("noMatch"),
      );

      const notExposed = probe("notExposed");
      expect(
        notExposed.code === "not_exposed" &&
          notExposed.tool === "get_oauth_access_token" &&
          notExposed.suggestions === null &&
          notExposed.message ===
            "Tool 'get_oauth_access_token' is not exposed to scripts (lifecycle/cred tool); use the MCP surface directly if you're an agent",
        show("notExposed"),
      );

      const invalidArgs = probe("invalidArgs");
      expect(
        invalidArgs.code === "invalid_args" &&
          invalidArgs.tool === "kv_get" &&
          invalidArgs.message === "kv tool requires string `key`",
        show("invalidArgs"),
      );

      const notFound = probe("notFound");
      expect(
        notFound.code === "not_found" &&
          notFound.tool === "script_run" &&
          notFound.status === 404 &&
          String(notFound.message).startsWith("swarm-sdk: script_run failed with 404"),
        show("notFound"),
      );

      const refused = probe("refused");
      expect(
        refused.code === "refused" &&
          refused.tool === "objects_get" &&
          String(refused.message).startsWith("ctx.objects.get failed"),
        show("refused"),
      );

      const sqlError = probe("sqlError");
      expect(
        sqlError.code === "invalid_args" &&
          sqlError.tool === "db_query" &&
          sqlError.status === 400 &&
          String(sqlError.message).startsWith("ctx.db.query failed with"),
        show("sqlError"),
      );

      const sqlShape =
        "ctx.db.query: sql must be a string or an object { sqlite: string; postgres: string }";
      for (const key of ["nullSql", "badSql"]) {
        const bad = probe(key);
        expect(
          bad.code === "invalid_args" &&
            bad.tool === "db_query" &&
            bad.status === null &&
            bad.message === sqlShape,
          show(key),
        );
      }

      const longName = asRecord(out.longName);
      const longError = asRecord(longName.result);
      expect(
        longError.name === "SwarmToolError" &&
          longError.code === "unknown_tool" &&
          JSON.stringify(longError.suggestions) === "[]" &&
          String(longError.message).includes("No exposed tool has a similar name"),
        `${label}: longName: ${JSON.stringify({ ...longError, message: undefined, tool: undefined })}`,
      );
      expect(
        typeof longName.ms === "number" && longName.ms < LONG_NAME_BUDGET_MS,
        `${label}: a ${LONG_NAME_LENGTH}-char method name must fail fast, took ${String(longName.ms)} ms`,
      );
    }
  },
};
