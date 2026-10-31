import { asRecord, asRecords, expect, expectStatus, pollUntil } from "../http";
import type { Scenario } from "../run";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  findScriptId,
  getLead,
  registerAgent,
  runScript,
  structured,
  toolText,
  upsertScript,
  withMcp,
} from "./script-helpers";

type ScriptRow = { version: number; typeChecked: number; isScratch: number; scope: string };

/**
 * Flow `script-saved-lifecycle`: upsert (typecheck) -> run by name -> versions -> get by id ->
 * types -> type-defs -> search -> delete, agent scope vs global scope (global needs a lead),
 * and the script-upsert / script-search / script-query-types / script-delete MCP tools.
 */
export const scriptSavedLifecycle: Scenario = {
  name: "script-saved-lifecycle",
  order: 410,
  async run(ctx) {
    const agentId = await registerAgent(ctx, "saved");
    const otherId = await registerAgent(ctx, "saved-other");
    const leadId = await getLead(ctx);
    const name = `e2e-saved-${ctx.nonce}`;
    const description = `doubles numbers marker${ctx.nonce}`;

    const source = (factor: number) => `import { z } from "zod";
export const argsSchema = z.object({ n: z.number() });
/** Multiplies a number by ${factor} */
export default async function (args: z.infer<typeof argsSchema>, ctx: any) {
  return { product: args.n * ${factor}, agent: typeof ctx.swarm };
}`;

    // ── upsert v1: typechecked, versioned, content-hash deduped ──
    const v1 = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: { name, source: source(2), description, intent: "e2e lifecycle" },
    });
    expectStatus(v1, [200], "upsert v1");
    expect(
      JSON.stringify(v1.json) === JSON.stringify({ name, version: 1, contentDeduped: false }),
      `upsert v1 response is wrong: ${v1.text}`,
    );
    const scriptId = await findScriptId(ctx, name, agentId, "agent");
    const same = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: { name, source: source(2), description, intent: "e2e lifecycle" },
    });
    expectStatus(same, [200], "upsert unchanged source");
    expect(
      asRecord(same.json).version === 1 && asRecord(same.json).contentDeduped === true,
      "re-saving identical source must dedupe and keep version 1",
    );
    const v2 = await upsertScript(ctx, agentId, {
      name,
      source: source(3),
      description,
      intent: "e2e lifecycle",
    });
    expect(v2.version === 2 && !v2.contentDeduped && v2.id === scriptId, "v2 must bump in place");
    const row = ctx.db.get<ScriptRow>(
      "SELECT version, typeChecked, isScratch, scope FROM scripts WHERE id = ?",
      [scriptId],
    );
    expect(
      row?.version === 2 && row.typeChecked === 1 && row.isScratch === 0 && row.scope === "agent",
      `saved script row is wrong: ${JSON.stringify(row)}`,
    );
    const versionRows = ctx.db.query<{ version: number }>(
      "SELECT version FROM script_versions WHERE scriptId = ? ORDER BY version",
      [scriptId],
    );
    expect(
      versionRows.map((entry) => entry.version).join(",") === "1,2",
      "script_versions must hold both versions",
    );

    // ── run by name with args; the current version runs ──
    const ran = await runScript(ctx, agentId, { name, args: { n: 7 } });
    expectRunOk(ran, "run saved script");
    expect(asRecord(ran.result).product === 21, "run by name did not run version 2");
    expect(ran.autoSaved === undefined, "named runs must not auto-save");
    const badArgs = await runScript(ctx, agentId, { name, args: { n: "seven" } });
    expect(
      badArgs.error === "eval_error" &&
        String(asRecord(badArgs.runtimeError).message).includes("argsSchema validation failed"),
      "bad args must fail the argsSchema validation",
    );
    // a run keeps the named script's saved executor unless the caller overrides it
    const viaQuickjs = await runScript(ctx, agentId, {
      name,
      args: { n: 2 },
      executor: "quickjs",
    });
    expectRunOk(viaQuickjs, "run saved script on quickjs");
    expect(asRecord(viaQuickjs.result).product === 6, "executor override changed the result");

    // ── versions: newest first, full source per version ──
    const versions = await ctx.api("GET", `/api/scripts/${scriptId}/versions`);
    expectStatus(versions, [200], "list versions");
    const versionList = asRecords(versions.json, "versions");
    expect(
      versionList.map((entry) => entry.version).join(",") === "2,1",
      "versions must be newest first",
    );
    expect(
      String(versionList[0]?.source).includes("n * 3") &&
        String(versionList[1]?.source).includes("n * 2"),
      "version sources do not match what was saved",
    );
    expect(
      versionList.every(
        (entry) => entry.scriptId === scriptId && /^[0-9a-f]{64}$/.test(String(entry.contentHash)),
      ),
      "version rows lost scriptId or contentHash",
    );
    expectStatus(
      await ctx.api("GET", "/api/scripts/00000000-0000-4000-8000-000000000000/versions"),
      [404],
      "versions of an unknown script",
    );

    // ── get by id: source, parsed signature, args JSON schema ──
    const detail = await ctx.api("GET", `/api/scripts/${scriptId}`);
    expectStatus(detail, [200], "get script by id");
    const script = asRecord(asRecord(detail.json).script);
    const signature = asRecord(script.signature);
    expect(
      script.id === scriptId &&
        script.name === name &&
        script.version === 2 &&
        script.isScratch === false &&
        script.typeChecked === true &&
        String(script.source).includes("n * 3") &&
        signature.description === "Multiplies a number by 3" &&
        signature.argsType === "z.infer<typeof argsSchema>",
      `script detail is wrong: ${detail.text.slice(0, 400)}`,
    );
    const argsSchema = asRecord(script.argsJsonSchema);
    expect(
      JSON.stringify(argsSchema.required) === JSON.stringify(["n"]) &&
        asRecord(asRecord(argsSchema.properties).n).type === "number",
      "argsJsonSchema was not extracted from argsSchema",
    );
    expectStatus(
      await ctx.api("GET", "/api/scripts/00000000-0000-4000-8000-000000000000"),
      [404],
      "get unknown script id",
    );
    expectStatus(await ctx.api("GET", "/api/scripts/not-a-uuid"), [400], "get script bad id");

    // ── types for a name (agent identity required) and the swarm-wide type-defs ──
    const types = await ctx.api("GET", `/api/scripts/${name}/types`, { agentId });
    expectStatus(types, [200], "script types");
    const typeBody = asRecord(types.json);
    expect(
      asRecord(typeBody.signature).description === "Multiplies a number by 3" &&
        asRecord(typeBody.argsJsonSchema).type === "object",
      "types lost the signature or args schema",
    );
    expect(
      String(typeBody.sdkTypes).includes("interface ScriptContext") &&
        String(typeBody.stdlibTypes).includes("function fetchJson"),
      "types must carry the SDK and stdlib declarations",
    );
    expectStatus(await ctx.api("GET", `/api/scripts/${name}/types`), [400], "types without agent");
    expectStatus(
      await ctx.api("GET", `/api/scripts/${name}/types`, { agentId: otherId }),
      [404],
      "another agent must not resolve this agent-scoped script",
    );
    expectStatus(
      await ctx.api("GET", `/api/scripts/${name}/types?scope=global`, { agentId }),
      [404],
      "agent-scoped script is not global",
    );
    expectStatus(
      await ctx.api("GET", `/api/scripts/no-such-${ctx.nonce}/types`, { agentId }),
      [404],
      "types of an unknown script",
    );
    const typeDefs = await ctx.api("GET", "/api/scripts/type-defs");
    expectStatus(typeDefs, [200], "type-defs");
    const defs = asRecord(typeDefs.json);
    expect(
      String(defs.sdkTypes).includes("interface SwarmSdk") &&
        String(defs.sdkTypes).includes("kv_incr") &&
        String(defs.stdlibTypes).includes("function table"),
      "type-defs must carry SwarmSdk and stdlib",
    );

    // ── search ──
    let found = false;
    const searched = await pollUntil(async () => {
      const search = await ctx.api("POST", "/api/scripts/search", {
        agentId,
        body: { query: `marker${ctx.nonce}`, limit: 5 },
      });
      expectStatus(search, [200], "search scripts");
      const hit = asRecords(search.json, "results").find((entry) => entry.name === name);
      if (hit) {
        found = true;
        expect(
          typeof hit.score === "number" &&
            hit.description === description &&
            asRecord(hit.signature).argsType === "z.infer<typeof argsSchema>",
          `search hit lost its metadata: ${JSON.stringify(hit).slice(0, 300)}`,
        );
      }
      return found;
    }, 15_000);
    expect(searched, `script ${name} never appeared in search results`);
    const emptyQuery = await ctx.api("POST", "/api/scripts/search", { agentId, body: {} });
    expectStatus(emptyQuery, [200], "search with an empty query");
    expect(asRecords(emptyQuery.json, "results").length <= 10, "default search limit is 10");
    expectStatus(
      await ctx.api("POST", "/api/scripts/search", { agentId, body: { limit: 0 } }),
      [400],
      "search limit 0",
    );
    expectStatus(
      await ctx.api("POST", "/api/scripts/search", { body: { query: "x" } }),
      [400],
      "search without agent",
    );

    // ── typecheck, secret and validation failures persist nothing ──
    const badName = `e2e-bad-${ctx.nonce}`;
    const typeError = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: {
        name: badName,
        source: `export default async function (args: { n: number }, ctx: any) { const x: number = "s"; return x; }`,
      },
    });
    expectStatus(typeError, [400], "upsert with a type error");
    const typeErrorBody = asRecord(typeError.json);
    expect(typeErrorBody.error === "typecheck_failed", "type error must be typecheck_failed");
    expect(
      Array.isArray(typeErrorBody.diagnostics) &&
        typeErrorBody.diagnostics.length > 0 &&
        String(typeErrorBody.diagnostics[0]).includes("TS2322"),
      "type error must carry diagnostics",
    );
    const structuredErrors = asRecords(typeErrorBody, "structured");
    expect(
      structuredErrors[0]?.code === 2322 && structuredErrors[0]?.severity === "error",
      "type error must carry structured diagnostics",
    );
    const token = ["xoxb", "123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx"].join("-");
    const secret = await ctx.api("POST", "/api/scripts/upsert", {
      agentId,
      body: {
        name: badName,
        source: `export default async function () { return "${token}"; }`,
      },
    });
    expectStatus(secret, [400], "upsert with a secret in the source");
    expect(asRecord(secret.json).error === "source_contains_secret", "wrong secret refusal");
    expectStatus(
      await ctx.api("POST", "/api/scripts/upsert", { agentId, body: { name: badName } }),
      [400],
      "upsert without source",
    );
    expectStatus(
      await ctx.api("POST", "/api/scripts/upsert", { body: { name: badName, source: "x" } }),
      [400],
      "upsert without agent",
    );
    const listedAfter = await ctx.api("GET", `/api/scripts?scope=agent`);
    expectStatus(listedAfter, [200], "list agent scripts");
    expect(
      !asRecords(listedAfter.json, "scripts").some((entry) => entry.name === badName),
      "a rejected upsert persisted a script",
    );
    expectStatus(await ctx.api("GET", "/api/scripts?scope=bogus"), [400], "list bad scope");

    // ── fsMode workspace-rw is accepted at save but refused at run (501) ──
    const rwName = `e2e-rw-${ctx.nonce}`;
    await upsertScript(ctx, agentId, {
      name: rwName,
      source: "export default async function () { return 1; }",
      fsMode: "workspace-rw",
    });
    const rwRun = await ctx.api("POST", "/api/scripts/run", { agentId, body: { name: rwName } });
    expectStatus(rwRun, [501], "run a workspace-rw script");

    // ── scopes: global writes need a lead, global scripts are visible to every agent ──
    const globalName = `e2e-global-${ctx.nonce}`;
    const globalBody = { name: globalName, scope: "global", source: source(5), description };
    const denied = await ctx.api("POST", "/api/scripts/upsert", { agentId, body: globalBody });
    expectStatus(denied, [403], "global upsert by a worker");
    const globalSaved = await ctx.api("POST", "/api/scripts/upsert", {
      agentId: leadId,
      body: globalBody,
    });
    expectStatus(globalSaved, [200], "global upsert by the lead");
    const globalId = await findScriptId(ctx, globalName, leadId, "global");
    const globalRow = ctx.db.get<ScriptRow>(
      "SELECT version, typeChecked, isScratch, scope FROM scripts WHERE id = ?",
      [globalId],
    );
    expect(globalRow?.scope === "global", "global script was not stored with global scope");
    const globalRun = await runScript(ctx, otherId, { name: globalName, args: { n: 2 } });
    expect(asRecord(globalRun.result).product === 10, "another agent must run a global script");
    const noGlobalDelete = await ctx.api("DELETE", `/api/scripts/${globalName}?scope=global`, {
      agentId,
    });
    expectStatus(noGlobalDelete, [403], "global delete by a worker");
    // a scoped delete only touches the scope it names
    const wrongScope = await ctx.api("DELETE", `/api/scripts/${globalName}?scope=agent`, {
      agentId,
    });
    expectStatus(wrongScope, [200], "agent-scope delete of a global name");
    expect(asRecord(wrongScope.json).deleted === false, "agent delete must not remove a global");

    // ── MCP tools: script-upsert, script-search, script-query-types, script-delete ──
    const toolName = `e2e-tool-${ctx.nonce}`;
    await withMcp(ctx, agentId, async (mcp) => {
      const saved = await callToolOk(mcp, "script-upsert", {
        name: toolName,
        source: `export default async function (args: { n: number }) { return args.n + 1; }`,
        description: `tool saved marker${ctx.nonce}`,
      });
      expect(toolText(saved).includes(`Script \`${toolName}\` v1 saved`), "script-upsert text");
      expect(
        asRecord(structured(saved).data).name === toolName,
        "script-upsert lost the saved name",
      );
      const typeFailure = await callToolErr(mcp, "script-upsert", {
        name: `${toolName}-bad`,
        source: `export default async function (args: { n: number }) { const x: number = "s"; return x; }`,
      });
      expect(toolText(typeFailure).includes("Typecheck failed"), "script-upsert typecheck text");
      expect(
        asRecord(structured(typeFailure).data).error === "typecheck_failed",
        "script-upsert type error must carry the API error",
      );

      const toolRun = await callToolOk(mcp, "script-run", { name: toolName, args: { n: 4 } });
      expect(
        toolText(toolRun).includes("result:\n5"),
        "tool-saved script returned the wrong value",
      );

      const search = await callToolOk(mcp, "script-search", {
        query: `marker${ctx.nonce}`,
        limit: 20,
      });
      expect(toolText(search).includes("Found "), "script-search text");
      const results = asRecords(asRecord(structured(search).data), "results");
      expect(
        results.some((entry) => entry.name === toolName || entry.name === name),
        "script-search must find a script saved with the marker",
      );

      // The type blobs are far larger than the MCP result ceiling, so the full text is spilled.
      const sdk = await callToolOk(mcp, "script-query-types", {});
      expect(
        String(structured(sdk).message).includes("type definitions fetched") &&
          toolText(sdk).includes("fullValueAt") === false,
        "script-query-types without a name must report the swarm-wide type surface",
      );
      const named = await callToolOk(mcp, "script-query-types", { name: toolName });
      expect(
        String(structured(named).message) ===
          `Type definitions for script \`${toolName}\` fetched.`,
        "script-query-types with a name must name the script",
      );
      const unknownTypes = await callToolErr(mcp, "script-query-types", {
        name: `no-such-${ctx.nonce}`,
      });
      expect(toolText(unknownTypes).includes("Script not found"), "unknown types lost 404");

      const globalDenied = await callToolErr(mcp, "script-delete", {
        name: globalName,
        scope: "global",
      });
      expect(
        toolText(globalDenied).includes("Global delete requires lead agent") &&
          structured(globalDenied).status === 403,
        "script-delete of a global script by a worker must be 403",
      );
      const deleted = await callToolOk(mcp, "script-delete", { name: toolName });
      expect(asRecord(structured(deleted).data).deleted === true, "tool delete");
    });
    const toolGone = ctx.db.get<{ n: number }>("SELECT count(*) AS n FROM scripts WHERE name = ?", [
      toolName,
    ]);
    expect(toolGone?.n === 0, "script-delete did not remove the script row");

    // ── delete: agent scope (idempotent), global scope as lead, rows gone ──
    const deleted = await ctx.api("DELETE", `/api/scripts/${name}?scope=agent`, { agentId });
    expectStatus(deleted, [200], "delete agent script");
    expect(asRecord(deleted.json).deleted === true, "delete must report deleted:true");
    const deletedAgain = await ctx.api("DELETE", `/api/scripts/${name}?scope=agent`, { agentId });
    expectStatus(deletedAgain, [200], "delete agent script again");
    expect(asRecord(deletedAgain.json).deleted === false, "second delete must report false");
    expectStatus(await ctx.api("GET", `/api/scripts/${scriptId}`), [404], "get after delete");
    expectStatus(
      await ctx.api("GET", `/api/scripts/${scriptId}/versions`),
      [404],
      "versions after delete",
    );
    const orphanVersions = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM script_versions WHERE scriptId = ?",
      [scriptId],
    );
    expect(orphanVersions?.n === 0, "deleting a script must cascade to its versions");
    const afterDelete = await ctx.api("POST", "/api/scripts/run", { agentId, body: { name } });
    expectStatus(afterDelete, [404], "run a deleted script");
    const globalDeleted = await ctx.api("DELETE", `/api/scripts/${globalName}?scope=global`, {
      agentId: leadId,
    });
    expectStatus(globalDeleted, [200], "global delete by the lead");
    expect(asRecord(globalDeleted.json).deleted === true, "lead global delete must succeed");
    await ctx.api("DELETE", `/api/scripts/${rwName}?scope=agent`, { agentId });
  },
};
