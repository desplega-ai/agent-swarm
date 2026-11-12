import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  callToolErr,
  callToolOk,
  expectRunOk,
  registerAgent,
  runScript,
  startStub,
  structured,
  toolText,
  withMcp,
} from "./script-helpers";

async function setAgentConfig(
  ctx: ScenarioContext,
  agentId: string,
  key: string,
  value: string,
): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "agent", scopeId: agentId, key, value, isSecret: key === "AGENT_FS_API_KEY" },
  });
  expectStatus(response, [200], `set agent config ${key}`);
  return asString(asRecord(response.json).id, `config ${key} id`);
}

/**
 * Flow `primitive-objects`: object-create / object-get / object-list / object-reindex and
 * `ctx.objects` in both executors, against a local agent-fs stub. Every call must carry the
 * agent's own agent-scoped AGENT_FS_API_KEY, never the swarm key. All config is agent-scoped,
 * so no other scenario sees it.
 */
export const knowledgeObjects: Scenario = {
  name: "knowledge-objects",
  order: 590,
  async run(ctx) {
    const ownKey = `af_own_${ctx.nonce}`;
    const org = `org-${ctx.nonce}`;
    const drive = `drive-${ctx.nonce}`;
    const files = new Map<string, { body: string; version: number }>();
    const stub = startStub((request, body) => {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${ownKey}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const raw = url.pathname.match(/^\/orgs\/[^/]+\/drives\/[^/]+\/files\/(.+)\/raw$/);
      if (raw) {
        const path = decodeURIComponent(raw[1] ?? "");
        const current = files.get(path);
        if (request.method === "GET") {
          return current
            ? new Response(current.body, {
                headers: { "x-agent-fs-version": String(current.version) },
              })
            : new Response("not found", { status: 404 });
        }
        const ifMatch = request.headers.get("if-match");
        if (request.headers.get("if-none-match") === "*" && current) {
          return new Response("exists", { status: 409 });
        }
        if (ifMatch && String(current?.version) !== ifMatch) {
          return new Response("version mismatch", { status: 409 });
        }
        const version = (current?.version ?? 0) + 1;
        files.set(path, { body, version });
        return Response.json({ path, version });
      }
      if (url.pathname === `/orgs/${org}/ops`) {
        // Honor the glob: reindex scans every kind, and each must see only its own files.
        const suffix = String(asRecord(JSON.parse(body)).pattern).replace("**/*", "");
        const matches = [...files.keys()]
          .filter((path) => path.endsWith(suffix))
          .map((path) => ({ path: `/${path}`, size: 1 }));
        return Response.json({ matches });
      }
      return new Response("not found", { status: 404 });
    });

    const agentId = await registerAgent(ctx, "objects");
    const keyless = await registerAgent(ctx, "objects-keyless");
    const configIds: string[] = [];
    try {
      for (const [key, value] of [
        ["AGENT_FS_API_KEY", ownKey],
        ["AGENT_FS_API_URL", stub.origin],
        ["AGENT_FS_DEFAULT_ORG_ID", org],
        ["AGENT_FS_DEFAULT_DRIVE_ID", drive],
      ] as const) {
        configIds.push(await setAgentConfig(ctx, agentId, key, value));
      }
      const path = `boards/e2e-${ctx.nonce}.excalidraw`;

      const id = await withMcp(ctx, agentId, async (mcp) => {
        const created = structured(
          await callToolOk(mcp, "object-create", { kind: "board", path: `/${path}`, title: "E2E" }),
        );
        const object = asRecord(created.object);
        const objectId = asString(object.id, "created object id");
        expect(object.path === path, `object path: ${JSON.stringify(object)}`);
        expect(
          JSON.parse(files.get(path)?.body ?? "{}").swarm?.id === objectId,
          "the id is embedded in the file",
        );
        const again = await callToolErr(mcp, "object-create", { kind: "board", path });
        expect(toolText(again).includes("already exists"), "object-create is create-only");
        const suffix = await callToolErr(mcp, "object-create", { kind: "board", path: "x.json" });
        expect(toolText(suffix).includes(".excalidraw"), "a board needs the .excalidraw suffix");

        const got = structured(
          await callToolOk(mcp, "object-get", { id: objectId, includeContent: true }),
        );
        expect(
          asRecord(got.content).type === "excalidraw" && got.missing === false,
          `object-get content: ${JSON.stringify(got).slice(0, 300)}`,
        );
        const listed = structured(await callToolOk(mcp, "object-list", { kind: "board" }));
        expect(
          Array.isArray(listed.objects) &&
            listed.objects.some((o) => asRecord(o).id === objectId) &&
            listed.total === 1,
          `object-list: ${JSON.stringify(listed).slice(0, 300)}`,
        );

        // A stock Excalidraw save drops the id; a second file arrives with none at all.
        files.set(path, { body: JSON.stringify({ type: "excalidraw", elements: [] }), version: 2 });
        files.set(`loose-${ctx.nonce}.excalidraw`, { body: JSON.stringify({ type: "excalidraw" }), version: 1 });
        const report = structured(await callToolOk(mcp, "object-reindex", {}));
        expect(
          report.scanned === 2 && Array.isArray(report.adopted) && report.adopted.length === 2,
          `object-reindex report: ${JSON.stringify(report)}`,
        );
        const after = structured(await callToolOk(mcp, "object-get", { path }));
        expect(asRecord(after.object).id === objectId, "reindex keeps the id at a known path");
        return objectId;
      });

      await withMcp(ctx, keyless, async (mcp) => {
        const refused = await callToolErr(mcp, "object-list", {});
        expect(toolText(refused).includes("no own AGENT_FS_API_KEY"), "an agent without a key is refused");
      });

      // ctx.objects in both executors: unwrapped results, refusals throw.
      for (const executor of ["native", "quickjs"] as const) {
        const run = await runScript(
          ctx,
          agentId,
          {
            executor,
            intent: `e2e objects ${executor} ${ctx.nonce}`,
            source: `export default async (_args, ctx) => {
  const created = await ctx.objects.create({ kind: "board", path: "${executor}-${ctx.nonce}.excalidraw" });
  const got = await ctx.objects.get({ id: ${JSON.stringify(id)} });
  let refusal = "";
  try { await ctx.objects.create({ kind: "board", path: "nope.txt" }); } catch (e) { refusal = String(e); }
  return { created: created.object.path, got: got.object.id, success: "success" in got, refusal };
};`,
          },
          `ctx.objects ${executor}`,
        );
        expectRunOk(run, `ctx.objects ${executor}`);
        const result = asRecord(run.result);
        expect(
          result.created === `${executor}-${ctx.nonce}.excalidraw` &&
            result.got === id &&
            result.success === false &&
            String(result.refusal).includes(".excalidraw"),
          `ctx.objects ${executor}: ${JSON.stringify(result)}`,
        );
      }

      expect(stub.seen.length > 0, "the stub saw agent-fs traffic");
      expect(
        stub.seen.every((entry) => entry.headers.authorization === `Bearer ${ownKey}`),
        "every agent-fs call carries the agent's own key",
      );
    } finally {
      stub.stop();
      for (const configId of configIds) await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};
