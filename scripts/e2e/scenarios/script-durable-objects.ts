import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  getLead,
  registerAgent,
  structured,
  toolText,
  upsertScript,
  withMcp,
} from "./script-helpers";

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
      ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM kv_entries WHERE namespace = ?", [
        namespace,
      ])?.n === 0,
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
      "SELECT signatureJson, typeChecked FROM scripts WHERE id = ?",
      [saved.id],
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
      "SELECT count(*) AS n FROM scripts WHERE scope = 'agent' AND scopeId = ?",
      [agentId],
    );
    expect(agentScripts?.n === 0, "refused durable source must not persist as an agent script");
    const inlineRuns = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM script_runs WHERE agentId = ?",
      [agentId],
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
