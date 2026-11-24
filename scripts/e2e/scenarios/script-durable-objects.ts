import { sql } from "../db";
import { asRecord, asRecords, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  getLead,
  registerAgent,
  runScript,
  structured,
  toolText,
  upsertScript,
  withMcp,
} from "./script-helpers";

const NESTED_ENV = { SCRIPT_QUICKJS_POOL_SIZE: "20" };

async function checkExecutor(
  ctx: ScenarioContext,
  agentId: string,
  leadId: string,
  functionName: string,
  executor: "native" | "quickjs",
) {
  const runtimeName = `e2e-counter-${ctx.nonce}-${executor}`;
  const recursiveName = `${runtimeName}-recursive`;
  const ttlName = `${runtimeName}-ttl`;
  const runtimeSource = `import { DurableObject } from "swarm-sdk";
export default class Counter extends DurableObject<{ n: number; secret?: string }> {
  initialState() { return { n: 0 }; }
  async add(args: { by: number }) {
    const before = this.state.n;
    await Promise.resolve();
    this.state.n = before + args.by;
    return this.state.n;
  }
  read() { return this.state; }
  fail() { this.state.n += 100; throw new Error("rollback counter"); }
  reset() { this.destroy(); return true; }
  remember(args: { secret: string }) { this.state.secret = args.secret; return true; }
  caller(_args: unknown, ctx: any) { return ctx.caller; }
  config(args: { key: string }, ctx: any) {
    return ctx.stdlib.Redacted.value(ctx.swarm.config.get(args.key));
  }
  async forward(args: { name: string; id: string; executor: string }, ctx: any) {
    return await ctx.swarm.script_run({ name: args.name, executor: args.executor,
      object: { id: args.id, method: "caller" } });
  }
  async reenter(args: { name: string; executor: string }, ctx: any) {
    try {
      return await ctx.swarm.script_run({ name: args.name, executor: args.executor,
        object: { id: this.id, method: "read" } });
    } catch (error) {
      const message = String(error);
      return { success: false, status: Number(message.match(/failed with (\\d+)/)?.[1]),
        data: { error: message } };
    }
  }
  _secret() { return "hidden"; }
}`;
  const runtime = await upsertScript(ctx, leadId, {
    name: runtimeName,
    source: runtimeSource,
    scope: "global",
    executor,
  });
  const durableNamespace = `durable:${runtime.id}`;
  const call = async (id: string, method: string, args?: unknown) => {
    const label = `${executor} object ${id}.${method}`;
    const run = await runScript(ctx, agentId, {
      name: runtimeName,
      scope: "global",
      executor,
      object: { id, method },
      args,
    });
    expectRunOk(run, label);
    const object = asRecord(run.object);
    expect(
      object.id === id &&
        Number.isInteger(object.stateVersion) &&
        typeof object.destroyed === "boolean",
      `${label}: missing object response`,
    );
    return run;
  };

  /** The reads the dashboard uses: list kind, per-object runs, and objects from raw KV. */
  async function checkDashboardReads() {
    const listed = await ctx.api("GET", "/api/scripts");
    expectStatus(listed, [200], `${executor}: list scripts`);
    const scripts = asRecords(listed.json, "scripts");
    const kindOf = (name: string) => scripts.find((script) => script.name === name)?.kind;
    expect(
      kindOf(runtimeName) === "durable" && kindOf(functionName) === "function",
      `${executor}: the script list must mark durable scripts: ${kindOf(runtimeName)}, ${kindOf(functionName)}`,
    );

    const query = `objectScriptId=${runtime.id}&objectId=b`;
    const objectRuns = await ctx.api("GET", `/api/script-runs?${query}`);
    expectStatus(objectRuns, [200], `${executor}: runs of one object`);
    const runs = asRecords(objectRuns.json, "runs");
    expect(
      runs.length >= 1 &&
        asRecord(objectRuns.json).total === runs.length &&
        runs.every(
          (run) =>
            run.objectScriptId === runtime.id &&
            run.objectId === "b" &&
            run.objectMethod === "read",
        ),
      `${executor}: the object filter must return only object b's runs: ${JSON.stringify(runs).slice(0, 400)}`,
    );

    const objects = await ctx.api(
      "GET",
      `/api/kv/_/${encodeURIComponent(durableNamespace)}?prefix=state/`,
      { agentId },
    );
    expectStatus(objects, [200], `${executor}: list objects from KV`);
    const entries = asRecords(objects.json, "entries");
    const stateOf = (id: string) => asRecord(entries.find((e) => e.key === `state/${id}`)?.value);
    expect(
      Number.isInteger(stateOf("a").stateVersion) && asRecord(stateOf("b").state).n === 0,
      `${executor}: KV must list each object's state: ${JSON.stringify(entries).slice(0, 400)}`,
    );
  }

  async function checkCounterLifecycle() {
    const key = `E2E_DURABLE_${ctx.nonce.toUpperCase()}`;
    const ordinary = await runScript(ctx, agentId, {
      source: `export default function(args: any, ctx: any) {
  return ctx.stdlib.Redacted.value(ctx.swarm.config.get(args.key));
}`,
      executor,
      args: { key },
    });
    expectRunOk(ordinary, `${executor} ordinary script config`);
    expect(
      ordinary.result === ctx.nonce &&
        (await call("config", "config", { key })).result === ctx.nonce,
      `${executor}: object must receive the same agent config as an ordinary script`,
    );
    expect((await call("a", "add", { by: 2 })).result === 2, `${executor}: first add`);
    await withMcp(ctx, agentId, async (mcp) => {
      const added = await callToolOk(mcp, "script-run", {
        name: runtimeName,
        scope: "global",
        executor,
        object: { id: "a", method: "add" },
        args: { by: 2 },
      });
      const run = asRecord(structured(added).data);
      expectRunOk(run, `${executor} MCP object add`);
      expect(
        run.result === 4 &&
          asRecord(run.object).id === "a" &&
          toolText(added).includes(`object.stateVersion: ${asRecord(run.object).stateVersion}`),
        `${executor}: MCP must preserve the object response and state`,
      );
    });
    expect(asRecord((await call("b", "read")).result).n === 0, `${executor}: isolated id`);
    await checkDashboardReads();

    const concurrent = await Promise.all(
      Array.from({ length: 5 }, () => call("concurrent", "add", { by: 1 })),
    );
    expect(
      concurrent
        .map((run) => run.result)
        .sort()
        .join(",") === "1,2,3,4,5" && asRecord((await call("concurrent", "read")).result).n === 5,
      `${executor}: concurrent calls must serialize without losing additions`,
    );
    const beforeFailure = ctx.db.get<{ value: string }>(
      sql`SELECT value FROM kv_entries WHERE namespace = ${durableNamespace} AND key = ${"state/a"}`,
    );
    const failed = await runScript(ctx, agentId, {
      name: runtimeName,
      executor,
      object: { id: "a", method: "fail" },
    });
    expect(
      failed.exitCode !== 0 && JSON.stringify(failed).includes("rollback counter"),
      `${executor}: thrown method must fail`,
    );
    expect(
      ctx.db.get<{ value: string }>(
        sql`SELECT value FROM kv_entries WHERE namespace = ${durableNamespace} AND key = ${"state/a"}`,
      )?.value === beforeFailure?.value && asRecord((await call("a", "read")).result).n === 4,
      `${executor}: thrown method must preserve the stored snapshot`,
    );
    for (const method of ["initialState", "_secret"]) {
      const refusedId = `refused-${method}`;
      const refused = await ctx.api("POST", "/api/scripts/run", {
        agentId,
        body: { name: runtimeName, executor, object: { id: refusedId, method } },
      });
      expectStatus(refused, [400], `${executor} reserved method ${method}`);
      expect(
        String(asRecord(refused.json).error).includes("not callable") &&
          ctx.db.get<{ n: number }>(
            sql`SELECT count(*) AS n FROM kv_entries WHERE namespace = ${durableNamespace} AND key IN (${`lease/${refusedId}`}, ${`state/${refusedId}`})`,
          )?.n === 0,
        `${executor}: reserved method must create no lease or state`,
      );
    }
    await call("destroyed", "add", { by: 9 });
    expect(
      asRecord((await call("destroyed", "reset")).object).destroyed === true &&
        asRecord((await call("destroyed", "read")).result).n === 0,
      `${executor}: destroy must restore the initial state on the next call`,
    );
  }

  async function checkCallerAndDepth() {
    const rootCaller = asRecord((await call("a", "caller")).result);
    expect(
      rootCaller.kind === "agent" && rootCaller.agentId === agentId,
      `${executor}: root caller must identify the agent`,
    );
    const nestedCaller = asRecord(
      (await call("parent", "forward", { name: runtimeName, id: "child", executor })).result,
    );
    const caller = asRecord(asRecord(nestedCaller.data).result);
    expect(
      nestedCaller.success === true &&
        caller.kind === "script" &&
        caller.agentId === agentId &&
        (caller.scriptId === undefined || caller.scriptId === runtime.id) &&
        (caller.objectId === undefined || caller.objectId === "parent"),
      `${executor}: nested caller must identify its agent without inventing provenance`,
    );
    const reentry = asRecord((await call("a", "reenter", { name: runtimeName, executor })).result);
    expect(
      reentry.success === false &&
        reentry.status === 409 &&
        String(asRecord(reentry.data).error).includes("already in this call chain"),
      `${executor}: self object call must fail with reentry`,
    );

    const recursive = await upsertScript(ctx, agentId, {
      name: recursiveName,
      executor,
      source: `export default async function (args: any, ctx: any): Promise<any> {
    if (args.objectName) return await ctx.swarm.script_run({ name: args.objectName,
      executor: args.executor, object: { id: "plain-caller", method: "caller" } });
    let nested;
    try {
      nested = await ctx.swarm.script_run({ name: args.name, executor: args.executor,
        args: { ...args, level: args.level + 1 } });
    } catch (error) {
      const message = String(error);
      nested = { success: false, status: Number(message.match(/failed with (\\d+)/)?.[1]),
        data: { error: message } };
    }
    return { level: args.level, attemptedLevel: args.level + 1, nested };
  }`,
    });
    const plain = await runScript(ctx, agentId, {
      name: recursiveName,
      executor,
      args: { objectName: runtimeName, executor },
    });
    expectRunOk(plain, `${executor} plain caller`);
    const plainNested = asRecord(plain.result);
    const plainCaller = asRecord(asRecord(plainNested.data).result);
    expect(
      plainNested.success === true &&
        plainCaller.kind === "script" &&
        plainCaller.agentId === agentId &&
        (plainCaller.scriptId === undefined || plainCaller.scriptId === recursive.id) &&
        plainCaller.objectId === undefined,
      `${executor}: plain script caller must identify its saved script`,
    );
    const recursion = await runScript(ctx, agentId, {
      name: recursiveName,
      executor,
      args: { name: recursiveName, executor, level: 1 },
    });
    expectRunOk(recursion, `${executor} recursive root`);
    let level = asRecord(recursion.result);
    for (let depth = 1; depth <= 16; depth++) {
      expect(level.level === depth, `${executor}: recursion lost level ${depth}`);
      const nested = asRecord(level.nested);
      if (depth === 16) {
        expect(
          level.attemptedLevel === 17 &&
            nested.success === false &&
            nested.status === 400 &&
            String(asRecord(nested.data).error).includes("call depth exceeds 16"),
          `${executor}: nested level 17 must hit the depth limit`,
        );
      } else {
        expect(nested.success === true, `${executor}: recursion failed before level 17`);
        const child = asRecord(nested.data);
        expectRunOk(child, `${executor} recursive level ${depth + 1}`);
        level = asRecord(child.result);
      }
    }
  }

  async function checkPersistenceAndMigration() {
    await ctx.restartSut({ env: NESTED_ENV });
    expect(
      asRecord((await call("a", "read")).result).n === 4,
      `${executor}: API restart must preserve state`,
    );
    await upsertScript(ctx, leadId, {
      name: ttlName,
      scope: "global",
      executor,
      source: runtimeSource.replace(
        "  initialState()",
        "  static idleTtlSec = 1;\n  initialState()",
      ),
    });
    const ttlBody = { name: ttlName, executor, object: { id: "ttl", method: "add" } };
    const ttlAdded = await runScript(ctx, agentId, { ...ttlBody, args: { by: 3 } });
    expectRunOk(ttlAdded, `${executor} TTL initial call`);
    expect(ttlAdded.result === 3, `${executor}: TTL object initial addition`);
    // This wait tests expiry itself, rather than waiting for an asynchronous side effect.
    await Bun.sleep(2_000);
    const expired = await runScript(ctx, agentId, { ...ttlBody, args: { by: 0 } });
    expectRunOk(expired, `${executor} TTL expired call`);
    expect(expired.result === 0, `${executor}: idle TTL must restore the initial state`);

    const fakeSecret = `sk-ant-api03-${"A".repeat(90)}`;
    const secretIdRun = await runScript(ctx, agentId, {
      name: runtimeName,
      executor,
      object: { id: fakeSecret, method: "read" },
    });
    expectRunOk(secretIdRun, `${executor} secret-shaped object id`);
    const secretIdRow = ctx.db.get<{ id: string }>(
      sql`SELECT id FROM script_runs WHERE "objectScriptId" = ${runtime.id} AND "objectId" = ${fakeSecret}`,
    );
    expect(secretIdRow, `${executor}: run must retain the exact object identity`);
    const history = await ctx.api("GET", `/api/script-runs/${secretIdRow.id}`, { agentId });
    expectStatus(history, [200], `${executor} object run history`);
    expect(
      !JSON.stringify(secretIdRun).includes(fakeSecret) &&
        !history.text.includes(fakeSecret) &&
        String(asRecord(asRecord(history.json).run).objectId).includes("[REDACTED"),
      `${executor}: run responses must scrub secret-shaped object ids`,
    );
    await call("a", "remember", { secret: fakeSecret });
    await withMcp(ctx, agentId, async (mcp) => {
      const snapshot = await callToolOk(mcp, "kv-get", {
        namespace: durableNamespace,
        key: "state/a",
      });
      const value = asRecord(asRecord(structured(snapshot).entry).value);
      expect(
        value.codeVersion === 1 &&
          asRecord(value.state).n === 4 &&
          String(asRecord(value.state).secret).includes("[REDACTED") &&
          !JSON.stringify(snapshot).includes(fakeSecret),
        `${executor}: KV inspection must show the snapshot with its secret scrubbed`,
      );
    });
    const migrated = await upsertScript(ctx, leadId, {
      name: runtimeName,
      scope: "global",
      executor,
      source: runtimeSource
        .replace("{ n: number; secret?: string }", "{ total: number; secret?: string }")
        .replace(
          "initialState() { return { n: 0 }; }",
          `initialState() { return { total: 0 }; }
    migrate(state: any) { return { total: state.n, secret: state.secret }; }`,
        )
        .replaceAll("this.state.n", "this.state.total"),
    });
    expect(migrated.version === 2, `${executor}: migration must create version 2`);
    const migratedState = asRecord((await call("a", "read")).result);
    expect(
      migratedState.total === 4 && migratedState.n === undefined,
      `${executor}: migration must change the persisted state shape`,
    );
    const storedMigration = asRecord(
      JSON.parse(
        ctx.db.get<{ value: string }>(
          sql`SELECT value FROM kv_entries WHERE namespace = ${durableNamespace} AND key = ${"state/a"}`,
        )?.value ?? "null",
      ),
    );
    expect(
      storedMigration.codeVersion === 2 &&
        asRecord(storedMigration.state).total === 4 &&
        asRecord(storedMigration.state).secret === fakeSecret,
      `${executor}: migration must persist state while KV inspection scrubs its secret`,
    );
    expect(
      ctx.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM script_runs WHERE "objectScriptId" = ${runtime.id} AND "objectId" = ${"a"} AND "objectMethod" = ${"add"} AND status = 'completed'`,
      )?.n === 2,
      `${executor}: run rows must record the object script, id, and method`,
    );
  }

  await checkCounterLifecycle();
  await checkCallerAndDepth();
  await checkPersistenceAndMigration();
  for (const body of [
    { name: runtimeName, executor },
    { name: functionName, executor, object: { id: "kind", method: "add" } },
    {
      source: "export default function () { return null; }",
      executor,
      object: { id: "inline", method: "read" },
    },
  ]) {
    expectStatus(
      await ctx.api("POST", "/api/scripts/run", { agentId, body }),
      [400],
      `${executor} object target body refusal`,
    );
  }
  for (const [scriptName, scope, owner] of [
    [runtimeName, "global", leadId],
    [ttlName, "global", leadId],
    [recursiveName, "agent", agentId],
  ]) {
    expectStatus(
      await ctx.api("DELETE", `/api/scripts/${scriptName}?scope=${scope}`, {
        agentId: owner,
      }),
      [200],
      `delete ${executor} runtime script`,
    );
  }
}

export const scriptDurableObjects: Scenario = {
  name: "script-durable-objects",
  order: 490,
  async run(ctx) {
    const leadId = await getLead(ctx);
    const agentId = await registerAgent(ctx, "durable");
    const namespace = `durable:${ctx.nonce}`;
    const kvPath = `/api/kv/_/${namespace}/state`;
    for (const [method, path, body] of [
      ["PUT", kvPath, { value: { n: 1 } }],
      ["DELETE", kvPath, undefined],
      ["POST", `${kvPath}/incr`, { by: 1 }],
    ] as const) {
      const refused = await ctx.api(method, path, { agentId, body });
      expectStatus(refused, [403], `durable HTTP ${method} refusal`);
      expect(
        String(asRecord(refused.json).error).includes("object calls"),
        "durable write refusal must explain ownership",
      );
    }
    expectStatus(await ctx.api("GET", kvPath, { agentId }), [404], "durable HTTP read is allowed");
    expectStatus(
      await ctx.api("GET", `/api/kv/_/${namespace}`, { agentId }),
      [200],
      "durable HTTP list is allowed",
    );
    await withMcp(ctx, agentId, async (mcp) => {
      for (const [tool, args] of [
        ["kv-set", { value: { n: 1 } }],
        ["kv-delete", {}],
        ["kv-incr", { by: 1 }],
      ] as const) {
        const refused = await callToolErr(mcp, tool, { namespace, key: "state", ...args });
        expect(
          toolText(refused).includes("object calls"),
          `durable ${tool} refusal must explain ownership`,
        );
      }
      const read = await callToolOk(mcp, "kv-get", { namespace, key: "state" });
      expect(structured(read).entry === null, "durable MCP read is allowed");
      await callToolOk(mcp, "kv-list", { namespace });
    });
    expect(
      ctx.db.get<{ n: number }>(
        sql`SELECT count(*) AS n FROM kv_entries WHERE namespace = ${namespace}`,
      )?.n === 0,
      "refused durable writes must create no rows",
    );

    const name = `e2e-counter-${ctx.nonce}`;
    const source = `import { DurableObject } from "swarm-sdk";
/** Counts additions. */
export default class Counter extends DurableObject<{ n: number }> {
  initialState() { return { n: 0 }; }
  /** Adds to the counter. */
  async add(args: { by: number }): Promise<number> {
    this.state.n += args.by;
    return this.state.n;
  }
  migrate(state: { n: number }) { return state; }
  _secret() { return "hidden"; }
  static helper() { return "static"; }
}`;

    const saved = await upsertScript(ctx, leadId, { name, source, scope: "global" });
    expect(saved.version === 1 && !saved.contentDeduped, "durable upsert must create version 1");
    const types = await ctx.api("GET", `/api/scripts/${name}/types?scope=global`, { agentId });
    expectStatus(types, [200], "durable script types");
    const signature = asRecord(asRecord(types.json).signature);
    const methods = asRecord(signature.methods);
    const add = asRecord(methods.add);
    expect(
      signature.kind === "durable" && Object.keys(methods).join(",") === "add",
      `durable signature must expose only add: ${JSON.stringify(signature)}`,
    );
    expect(
      signature.argsType === "unknown" &&
        signature.resultType === "unknown" &&
        signature.description === "Counts additions." &&
        add.argsType === "{ by: number }" &&
        add.resultType === "number" &&
        add.description === "Adds to the counter.",
      "durable signature lost its types or descriptions",
    );
    const row = ctx.db.get<{ signatureJson: string; typeChecked: number }>(
      sql`SELECT "signatureJson", "typeChecked" FROM scripts WHERE id = ${saved.id}`,
    );
    expect(
      row?.typeChecked === 1 && JSON.parse(row.signatureJson).kind === "durable",
      "durable signature must persist after typecheck",
    );

    const refused = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: { name, source, scope: "agent" },
    });
    expectStatus(refused, [400], "agent scope durable upsert");
    expect(
      asRecord(refused.json).error === "DurableObject scripts must be global scope",
      "agent scope upsert must explain the global scope requirement",
    );
    const inline = await ctx.api("POST", "/api/scripts/run", { agentId, body: { source } });
    expectStatus(inline, [400], "inline durable run");
    expect(
      String(asRecord(inline.json).error).includes("DurableObject"),
      "inline refusal must identify the DurableObject source",
    );
    const agentScripts = ctx.db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM scripts WHERE scope = 'agent' AND "scopeId" = ${agentId}`,
    );
    expect(agentScripts?.n === 0, "refused durable source must not persist as an agent script");
    const inlineRuns = ctx.db.get<{ n: number }>(
      sql`SELECT count(*) AS n FROM script_runs WHERE "agentId" = ${agentId}`,
    );
    expect(inlineRuns?.n === 0, "refused durable source must not execute");

    for (const [suffix, variant] of [
      [
        "named",
        `import { DurableObject as Base } from "swarm-sdk";
class Counter extends Base<{ n: number }> {
  initialState() { return { n: 0 }; }
  add(args: { by: number }): number { return this.state.n += args.by; }
}
export default Counter;`,
      ],
      [
        "inherited",
        `import * as s from "swarm-sdk";
class Base extends s.DurableObject<{ n: number }> {
  initialState() { return { n: 0 }; }
  add(args: { by: number }): number { return this.state.n += args.by; }
  label(): number | string { return 1; }
  get hidden(): number { return 1; }
  static helper() { return "static"; }
  _private() { return "private"; }
}
class Middle extends Base {}
export default class Counter extends Middle {
  label(): string { return "counter"; }
}`,
      ],
    ] as const) {
      const variantName = `${name}-${suffix}`;
      await upsertScript(ctx, leadId, { name: variantName, source: variant, scope: "global" });
      const types = await ctx.api("GET", `/api/scripts/${variantName}/types?scope=global`, {
        agentId,
      });
      expectStatus(types, [200], `${suffix} durable types`);
      const signature = asRecord(asRecord(types.json).signature);
      const methods = asRecord(signature.methods);
      expect(
        signature.kind === "durable" && asRecord(methods.add).resultType === "number",
        `${suffix} must detect durable inheritance`,
      );
      expect(
        Object.keys(methods).sort().join(",") === (suffix === "inherited" ? "add,label" : "add"),
        `${suffix} must exclude private and reserved methods`,
      );
      if (suffix === "inherited")
        expect(
          asRecord(methods.label).resultType === "string",
          "subclass method must override its base",
        );
      expectStatus(
        await ctx.api("DELETE", `/api/scripts/${variantName}?scope=global`, { agentId: leadId }),
        [200],
        "delete durable variant",
      );
    }

    const functionName = `e2e-function-${ctx.nonce}`;
    await upsertScript(ctx, agentId, {
      name: functionName,
      source: "export default function (args: { n: number }): number { return args.n + 1; }",
    });
    const functionTypes = await ctx.api("GET", `/api/scripts/${functionName}/types`, { agentId });
    expectStatus(functionTypes, [200], "function script types");
    expect(
      JSON.stringify(asRecord(functionTypes.json).signature) ===
        JSON.stringify({ argsType: "{ n: number }", resultType: "number", description: "" }),
      "function signature must remain unchanged",
    );

    const config = await ctx.api("PUT", "/api/config", {
      body: {
        scope: "agent",
        scopeId: agentId,
        key: `E2E_DURABLE_${ctx.nonce.toUpperCase()}`,
        value: ctx.nonce,
        isSecret: false,
      },
    });
    expectStatus(config, [200], "store durable object agent config");
    const configId = asRecord(config.json).id;
    expect(typeof configId === "string", "durable object config id");
    // Recursive SDK calls hold their executor slots until every child returns.
    try {
      await ctx.restartSut({ env: NESTED_ENV });
      for (const executor of ["native", "quickjs"] as const) {
        await checkExecutor(ctx, agentId, leadId, functionName, executor);
      }
    } finally {
      await ctx.restartSut();
      expectStatus(
        await ctx.api("DELETE", `/api/config/${configId}`),
        [200],
        "delete durable object agent config",
      );
    }

    expectStatus(
      await ctx.api("DELETE", `/api/scripts/${name}?scope=global`, { agentId: leadId }),
      [200],
      "delete durable script",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/scripts/${functionName}?scope=agent`, { agentId }),
      [200],
      "delete function script",
    );
  },
};
