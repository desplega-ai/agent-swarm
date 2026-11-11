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
  upsertScript,
  withMcp,
} from "./script-helpers";

type Element = Record<string, unknown> & { id: string; type: string };

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

const sortedKeys = (value: unknown) => Object.keys(asRecord(value)).sort();

/**
 * Flow `primitive-boards`: every board-* tool over MCP as one round trip (create with shapes and
 * bound arrows, add, update, remove, get, list), its refusals (unknown id, invalid elements,
 * agent-fs 409s, a stock save without `swarm.id`), and `ctx.boards` in both executors returning
 * the tool's shape. Runs against a local agent-fs stub with the agent's own key; all config is
 * agent-scoped, so no other scenario sees it.
 */
export const knowledgeBoards: Scenario = {
  name: "knowledge-boards",
  order: 591,
  async run(ctx) {
    const ownKey = `af_boards_${ctx.nonce}`;
    const org = `org-b-${ctx.nonce}`;
    const drive = `drive-b-${ctx.nonce}`;
    const files = new Map<string, { body: string; version: number }>();
    // Concurrent writers to simulate on the next guarded writes (each bumps the version first).
    let raceWrites = 0;
    let conflicts = 0;
    const stub = startStub((request, body) => {
      const url = new URL(request.url);
      if (request.headers.get("authorization") !== `Bearer ${ownKey}`) {
        return new Response("unauthorized", { status: 401 });
      }
      const raw = url.pathname.match(/^\/orgs\/[^/]+\/drives\/[^/]+\/files\/(.+)\/raw$/);
      if (!raw) return new Response("not found", { status: 404 });
      const path = decodeURIComponent(raw[1] ?? "");
      if (request.method === "GET") {
        const current = files.get(path);
        return current
          ? new Response(current.body, {
              headers: { "x-agent-fs-version": String(current.version) },
            })
          : new Response("not found", { status: 404 });
      }
      const ifMatch = request.headers.get("if-match");
      if (ifMatch && raceWrites > 0) {
        raceWrites -= 1;
        const current = files.get(path);
        if (current) files.set(path, { ...current, version: current.version + 1 });
      }
      const current = files.get(path);
      if (request.headers.get("if-none-match") === "*" && current) {
        return new Response("exists", { status: 409 });
      }
      if (ifMatch && String(current?.version) !== ifMatch) {
        conflicts += 1;
        return new Response("version mismatch", { status: 409 });
      }
      const version = (current?.version ?? 0) + 1;
      files.set(path, { body, version });
      return Response.json({ path, version });
    });
    const scene = (path: string) =>
      JSON.parse(files.get(path)?.body ?? "{}") as {
        elements?: Element[];
        swarm?: { id?: string };
      };
    const element = (path: string, id: string): Element => {
      const found = scene(path).elements?.find((e) => e.id === id);
      expect(found, `${path} has no element ${id}`);
      return found as Element;
    };

    const agentId = await registerAgent(ctx, "boards");
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

      const toolShapes = await withMcp(ctx, agentId, async (mcp) => {
        // Round trip: create with shapes and arrows bound on both ends.
        const created = structured(
          await callToolOk(mcp, "board-create", {
            path: `/${path}`,
            title: "E2E board",
            shapes: [
              { key: "a", type: "rectangle", label: "Request", color: "blue" },
              { key: "b", type: "diamond", label: "Lead" },
            ],
            arrows: [{ from: "a", to: "b", label: "send" }],
          }),
        );
        const boardId = asString(asRecord(created.object).id, "board id");
        const added = asRecord(created.added);
        const [a, b, ab] = [added.a, added.b, added["arrows[0]"]].map((v) =>
          asString(v, "added id"),
        );
        expect(
          created.version === 1,
          `board-create version: ${JSON.stringify(created).slice(0, 300)}`,
        );
        expect(scene(path).swarm?.id === boardId, "the board id is embedded in the file");
        const arrow = element(path, ab);
        expect(
          asRecord(arrow.startBinding).elementId === a &&
            asRecord(arrow.endBinding).elementId === b,
          `arrow bindings: ${JSON.stringify(arrow).slice(0, 300)}`,
        );
        for (const end of [a, b]) {
          const refs = element(path, end).boundElements;
          expect(
            Array.isArray(refs) && refs.some((r) => asRecord(r).id === ab),
            `shape ${end} lists the arrow in boundElements`,
          );
        }

        const grown = structured(
          await callToolOk(mcp, "board-add-elements", {
            id: boardId,
            shapes: [{ key: "c", type: "ellipse", label: "Worker" }],
            arrows: [{ from: b, to: "c" }],
          }),
        );
        const c = asString(asRecord(grown.added).c, "added c");
        expect(
          grown.version === 2,
          `board-add-elements version: ${JSON.stringify(grown).slice(0, 300)}`,
        );

        const bBefore = Number(element(path, b).version);
        const updated = structured(
          await callToolOk(mcp, "board-update-elements", {
            path,
            patches: [{ elementId: b, label: "Lead triages and routes", y: 300 }],
          }),
        );
        expect(updated.version === 3, `board-update-elements version: ${JSON.stringify(updated)}`);
        expect(Number(element(path, b).version) > bBefore, "an update bumps the element version");

        const removed = structured(
          await callToolOk(mcp, "board-remove-elements", { id: boardId, elementIds: [c] }),
        );
        expect(
          JSON.stringify(removed.removed) === JSON.stringify([c]) &&
            element(path, c).isDeleted === true,
          `board-remove-elements sets isDeleted: ${JSON.stringify(removed)}`,
        );

        const got = structured(await callToolOk(mcp, "board-get", { id: boardId }));
        const summary = (got.elements as unknown[]).map(asRecord);
        const bSummary = summary.find((e) => e.id === b);
        expect(
          got.version === 4 &&
            summary.length === 4 &&
            !summary.some((e) => e.id === c) &&
            bSummary?.text === "Lead triages and routes" &&
            bSummary?.y === 300,
          `board-get summary: ${JSON.stringify(got).slice(0, 600)}`,
        );
        const full = structured(await callToolOk(mcp, "board-get", { path, detail: "full" }));
        expect(
          Array.isArray(full.elements) && full.elements.length > summary.length,
          "detail full returns raw elements, labels included",
        );
        const listed = structured(await callToolOk(mcp, "board-list", { prefix: "boards/" }));
        expect(
          listed.total === 1 && asRecord((listed.objects as unknown[])[0]).id === boardId,
          `board-list: ${JSON.stringify(listed).slice(0, 300)}`,
        );

        // Refusals: unknown id, invalid element input, none of which writes.
        const unknown = await callToolErr(mcp, "board-get", { id: "no-such-board" });
        expect(toolText(unknown).includes("no object"), `unknown board: ${toolText(unknown)}`);
        const missingElement = await callToolErr(mcp, "board-update-elements", {
          id: boardId,
          patches: [{ elementId: "no-such-element", label: "x" }],
        });
        expect(
          toolText(missingElement).includes("no live element"),
          "unknown element id is refused",
        );
        const badArrow = await callToolErr(mcp, "board-add-elements", {
          id: boardId,
          arrows: [{ from: a, to: "ghost" }],
        });
        expect(
          toolText(badArrow).includes("'ghost' is not a shape key"),
          `bad arrow: ${toolText(badArrow)}`,
        );
        const badColor = await callToolErr(mcp, "board-add-elements", {
          id: boardId,
          shapes: [{ type: "rectangle", color: "chartreuse" }],
        });
        expect(
          toolText(badColor).includes("not a palette name"),
          `bad color: ${toolText(badColor)}`,
        );
        const badCreate = await callToolErr(mcp, "board-create", { path: "x.json" });
        expect(toolText(badCreate).includes(".excalidraw"), "a board needs the .excalidraw suffix");
        expect(files.get(path)?.version === 4, "refusals write nothing");

        // agent-fs 409: one concurrent write is re-read and re-applied; four in a row refuse.
        raceWrites = 1;
        conflicts = 0;
        const merged = structured(
          await callToolOk(mcp, "board-add-elements", {
            id: boardId,
            shapes: [{ key: "d", type: "rectangle", label: "after a race" }],
          }),
        );
        const d = asString(asRecord(merged.added).d, "added d");
        expect(
          conflicts === 1 && merged.version === 6,
          `409 retry: ${conflicts} ${JSON.stringify(merged)}`,
        );
        expect(element(path, d).isDeleted === false, "the retried write landed");
        raceWrites = 4;
        conflicts = 0;
        const busy = await callToolErr(mcp, "board-add-elements", {
          id: boardId,
          shapes: [{ type: "rectangle", label: "never" }],
        });
        expect(
          conflicts === 4 && toolText(busy).includes("concurrent writers"),
          `4 conflicts refuse: ${conflicts} ${toolText(busy)}`,
        );
        raceWrites = 0;

        // A stock Excalidraw save drops `swarm.id`: the board still resolves by path and heals.
        const stockVersion = (files.get(path)?.version ?? 0) + 1;
        files.set(path, {
          body: JSON.stringify({
            type: "excalidraw",
            version: 2,
            source: "excalidraw",
            elements: scene(path).elements,
          }),
          version: stockVersion,
        });
        const stock = structured(await callToolOk(mcp, "board-get", { path }));
        expect(asRecord(stock.object).id === boardId, "a stock save resolves by path");
        await callToolOk(mcp, "board-update-elements", {
          path,
          patches: [{ elementId: a, color: "green" }],
        });
        expect(scene(path).swarm?.id === boardId, "the next write re-embeds swarm.id");

        return {
          create: sortedKeys(created),
          get: sortedKeys(got),
          add: sortedKeys(merged),
          summaryElement: sortedKeys(summary[0]),
        };
      });

      // ctx.boards in both executors: the tool payload minus `success`; refusals throw.
      for (const executor of ["native", "quickjs"] as const) {
        const scriptPath = `scripts/${executor}-${ctx.nonce}.excalidraw`;
        const run = await runScript(
          ctx,
          agentId,
          {
            executor,
            intent: `e2e boards ${executor} ${ctx.nonce}`,
            source: `export default async (_args, ctx) => {
  const keys = (v) => Object.keys(v).sort();
  const created = await ctx.boards.create({ path: ${JSON.stringify(scriptPath)}, shapes: [{ key: "x", type: "rectangle", label: "X" }, { key: "y", type: "text", label: "Y" }], arrows: [{ from: "x", to: "y" }] });
  const id = created.object.id;
  const added = await ctx.boards.addElements({ id, shapes: [{ key: "z", type: "diamond", label: "Z" }], arrows: [{ from: created.added.x, to: "z" }] });
  const updated = await ctx.boards.updateElements({ id, patches: [{ elementId: added.added.z, label: "Zed" }] });
  const removed = await ctx.boards.removeElements({ id, elementIds: [created.added.y] });
  const got = await ctx.boards.get({ id });
  const listed = await ctx.boards.list({ prefix: "scripts/" });
  let refusal = "";
  try { await ctx.boards.get({ id: "no-such-board" }); } catch (e) { refusal = String(e); }
  return {
    create: keys(created), get: keys(got), add: keys(added), summaryElement: keys(got.elements[0]),
    versions: [created.version, added.version, updated.version, removed.version, got.version],
    live: got.elements.length, listed: listed.total, success: "success" in got, refusal,
  };
};`,
          },
          `ctx.boards ${executor}`,
        );
        expectRunOk(run, `ctx.boards ${executor}`);
        const result = asRecord(run.result);
        for (const key of ["create", "get", "add", "summaryElement"] as const) {
          expect(
            JSON.stringify(result[key]) ===
              JSON.stringify(toolShapes[key].filter((k) => k !== "success")),
            `ctx.boards ${executor} ${key} keys ${JSON.stringify(result[key])} differ from the tool's ${JSON.stringify(toolShapes[key])}`,
          );
        }
        expect(
          JSON.stringify(result.versions) === JSON.stringify([1, 2, 3, 4, 4]) &&
            result.live === 4 &&
            result.success === false &&
            String(result.refusal).includes("no object"),
          `ctx.boards ${executor}: ${JSON.stringify(result)}`,
        );
      }
      const lists = await withMcp(ctx, agentId, async (mcp) =>
        structured(await callToolOk(mcp, "board-list", { prefix: "scripts/" })),
      );
      expect(
        lists.total === 2,
        `both executors created a board: ${JSON.stringify(lists).slice(0, 200)}`,
      );

      // A stored script typechecks against the ctx.boards types.
      await upsertScript(ctx, agentId, {
        name: `e2e-boards-typed-${ctx.nonce}`,
        intent: "typecheck ctx.boards",
        source: `import type { ScriptContext } from "swarm-sdk";

export default async (_args: unknown, ctx: ScriptContext) => {
  const { elements } = await ctx.boards.get({ path: "a.excalidraw" });
  const first = elements[0];
  return { text: first?.text ?? null, ends: first?.boundTo ?? [] };
};`,
      });

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
