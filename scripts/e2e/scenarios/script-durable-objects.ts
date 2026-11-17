import { asRecord, expect, expectStatus } from "../http";
import type { Scenario } from "../run";
import { getLead, registerAgent, upsertScript } from "./script-helpers";

export const scriptDurableObjects: Scenario = {
  name: "script-durable-objects",
  order: 490,
  async run(ctx) {
    const leadId = await getLead(ctx);
    const agentId = await registerAgent(ctx, "durable");
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
