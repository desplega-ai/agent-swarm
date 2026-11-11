import { createHmac } from "node:crypto";
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

async function setGlobalConfig(ctx: ScenarioContext, key: string, value: string): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope: "global", scopeId: null, key, value, isSecret: key === "API_AGENT_FS_API_KEY" },
  });
  expectStatus(response, [200], `set global config ${key}`);
  return asString(asRecord(response.json).id, `config ${key} id`);
}

const WEBHOOK_SECRET = `whsec_${Buffer.from("e2e-object-webhook-secret-32byte").toString("base64")}`;

/** POST one Standard Webhooks delivery, signed like agent-fs signs it. */
function signedDelivery(
  ctx: ScenarioContext,
  receiver: string,
  secret: string,
  id: string,
  envelope: unknown,
) {
  const body = JSON.stringify(envelope);
  const timestamp = Math.floor(Date.now() / 1000);
  const key = Buffer.from(secret.slice("whsec_".length), "base64");
  const signature = createHmac("sha256", key).update(`${id}.${timestamp}.${body}`).digest("base64");
  return ctx.api("POST", receiver, {
    apiKey: null,
    rawBody: body,
    headers: {
      "content-type": "application/json",
      "webhook-id": id,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": `v1,${signature}`,
    },
  });
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
    const serviceKey = `af_service_${ctx.nonce}`;
    const files = new Map<string, { body: string; version: number }>();
    const hooks: Array<{ id: string; url: string; eventTypes: string[] }> = [];
    const stub = startStub((request, body) => {
      const url = new URL(request.url);
      const bearer = request.headers.get("authorization");
      if (bearer !== `Bearer ${ownKey}` && bearer !== `Bearer ${serviceKey}`) {
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
        const op = JSON.parse(body) as Record<string, unknown>;
        if (op.op === "webhook-list") return Response.json({ webhooks: hooks });
        if (op.op === "webhook-create") {
          const hook = {
            id: `hook-${ctx.nonce}`,
            url: String(op.url),
            eventTypes: op.eventTypes as string[],
          };
          hooks.push(hook);
          return Response.json({ ...hook, secret: WEBHOOK_SECRET });
        }
        if (op.op !== "glob") return new Response("unsupported op", { status: 400 });
        const matches = [...files.keys()]
          .filter((path) => path.endsWith(".excalidraw"))
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
      // `#`, `?` and a space must stay in the raw URL path, or the stub never sees the file.
      const path = `boards/e2e #${ctx.nonce}?v=1.excalidraw`;

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
        files.set(`loose-${ctx.nonce}.excalidraw`, {
          body: JSON.stringify({ type: "excalidraw" }),
          version: 1,
        });
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
        expect(
          toolText(refused).includes("agent-fs is not configured for this agent"),
          "an agent without a key is refused",
        );
      });

      // agent-fs file.changed webhooks. With the API's service key configured, the next object
      // call registers one drive hook; the scenario then signs deliveries with the secret the
      // stub handed out, the way agent-fs does (Standard Webhooks).
      for (const [key, value] of [
        ["AGENT_FS_API_URL", stub.origin],
        ["API_AGENT_FS_API_KEY", serviceKey],
        ["AGENT_FS_DEFAULT_ORG_ID", org],
      ] as const) {
        configIds.push(await setGlobalConfig(ctx, key, value));
      }
      await withMcp(ctx, agentId, async (mcp) => {
        await callToolOk(mcp, "object-reindex", {});
      });
      const deadline = Date.now() + 10_000;
      while (hooks.length === 0 && Date.now() < deadline) await Bun.sleep(100);
      expect(hooks.length === 1, `one drive hook registered: ${JSON.stringify(hooks)}`);
      const hook = hooks[0] as (typeof hooks)[number];
      expect(
        JSON.stringify(hook.eventTypes) === JSON.stringify(["file.changed"]),
        "the hook asks for file.changed only",
      );
      const receiver = new URL(hook.url).pathname;
      // The receiver reads the changed file with the service key: no agent is calling.
      const receiverCalls = new Set<number>();
      const deliver = async (
        data: Record<string, unknown>,
        opts: { secret?: string; id?: string } = {},
      ) => {
        const from = stub.seen.length;
        const response = await signedDelivery(
          ctx,
          receiver,
          opts.secret ?? WEBHOOK_SECRET,
          opts.id ?? crypto.randomUUID(),
          {
            type: "file.changed",
            timestamp: new Date().toISOString(),
            data: { orgId: org, driveId: drive, path: `/${path}`, ...data },
          },
        );
        for (let i = from; i < stub.seen.length; i++) receiverCalls.add(i);
        return response;
      };
      const base = files.get(path)?.version ?? 0;
      const forgedSecret = `whsec_${Buffer.from("f".repeat(32)).toString("base64")}`;
      const forged = await deliver(
        { version: base + 1, operation: "delete" },
        { secret: forgedSecret },
      );
      expectStatus(forged, [401], "a delivery signed with another secret");
      const unsigned = await ctx.api("POST", receiver, { apiKey: null, rawBody: "{}" });
      expectStatus(unsigned, [401], "a delivery without signature headers");
      const unknown = await ctx.api("POST", `/api/objects/agent-fs-webhook/${ctx.nonce}`, {
        apiKey: null,
        rawBody: "{}",
      });
      expectStatus(unknown, [401], "an unknown receiver id");
      const huge = await ctx.api("POST", receiver, { apiKey: null, rawBody: "x".repeat(70_000) });
      expectStatus(huge, [413], "receiver body cap");

      const action = (response: { json: unknown }) => asRecord(response.json).action;
      // object-get reports the live file's version, so the stub applies each genuine change
      // before its event is delivered, the order agent-fs uses.
      const stored = files.get(path)?.body ?? "{}";
      files.set(path, { body: stored, version: base + 1 });
      const edit = await deliver({ version: base + 1, operation: "edit" }, { id: "msg_edit" });
      expectStatus(edit, [200], "signed edit");
      expect(action(edit) === "updated", `edit: ${edit.text}`);
      const replay = await deliver({ version: base + 1, operation: "edit" }, { id: "msg_edit" });
      expect(
        action(replay) === "ignored" && asRecord(replay.json).reason === "stale event",
        `a replayed event is a no-op: ${replay.text}`,
      );
      files.delete(path);
      const deleted = await deliver({ version: base + 2, operation: "delete" });
      expect(action(deleted) === "tombstoned", `delete: ${deleted.text}`);
      const late = await deliver({ version: base + 1, operation: "write" });
      expect(action(late) === "ignored", `a late write below the stored version: ${late.text}`);
      await withMcp(ctx, agentId, async (mcp) => {
        const got = asRecord(structured(await callToolOk(mcp, "object-get", { id })).object);
        expect(
          got.fileVersion === base + 2 && typeof got.deletedAt === "string",
          `the row is tombstoned at the delete's version: ${JSON.stringify(got)}`,
        );
        const listed = structured(await callToolOk(mcp, "object-list", { kind: "board" }));
        expect(
          Array.isArray(listed.objects) && !listed.objects.some((o) => asRecord(o).id === id),
          "object-list hides a tombstoned object",
        );
      });
      files.set(path, { body: stored, version: base + 3 });
      const restored = await deliver({ version: base + 3, operation: "write" });
      expect(action(restored) === "updated", `write: ${restored.text}`);
      const otherDrive = await deliver({ version: base + 4, operation: "edit", driveId: "other" });
      expect(action(otherDrive) === "ignored", `an event for another drive: ${otherDrive.text}`);
      const notObject = await deliver({ version: 1, operation: "write", path: "/notes/a.md" });
      expect(
        asRecord(notObject.json).reason === "not an object path",
        `a non-object path: ${notObject.text}`,
      );
      await withMcp(ctx, agentId, async (mcp) => {
        const got = asRecord(structured(await callToolOk(mcp, "object-get", { id })).object);
        expect(
          got.fileVersion === base + 3 && got.deletedAt === null,
          `a write brings the object back: ${JSON.stringify(got)}`,
        );
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
      const isWebhookOp = (body: string) => body.includes('"op":"webhook-');
      expect(receiverCalls.size > 0, "the receiver read the changed file");
      const wrongKey = stub.seen.filter(
        (entry, i) =>
          entry.headers.authorization !==
          `Bearer ${isWebhookOp(entry.body) || receiverCalls.has(i) ? serviceKey : ownKey}`,
      );
      expect(
        wrongKey.length === 0,
        `object calls carry the agent's own key; only webhook registration and the receiver use the service key: ${JSON.stringify(wrongKey.map((e) => `${e.method} ${e.path}`))}`,
      );
    } finally {
      stub.stop();
      for (const configId of configIds) await ctx.api("DELETE", `/api/config/${configId}`);
    }
  },
};
