import { asRecord, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
import {
  agentFsRawJsonRejection,
  callToolOk,
  registerAgent,
  startStub,
  structured,
  withMcp,
} from "./script-helpers";

function cookiePair(headers: Headers): string {
  return headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0] ?? "")
    .filter((pair) => pair.includes("=") && !pair.endsWith("="))
    .join("; ");
}

async function setConfig(
  ctx: ScenarioContext,
  scope: "global" | "agent",
  scopeId: string | null,
  key: string,
  value: string,
): Promise<string> {
  const response = await ctx.api("PUT", "/api/config", {
    body: { scope, scopeId, key, value, isSecret: key.endsWith("API_KEY") },
  });
  expectStatus(response, [200], `set ${scope} config ${key}`);
  return asString(asRecord(response.json).id, `config ${key} id`);
}

/**
 * Flow `primitive-object-http`: the object routes people use (an app's ObjectEmbed, a page's
 * `<swarm-object>`). GET /api/objects/:id with knownVersion, PUT .../content for boards and
 * POST .../sheet-ops, against an agent-fs stub. The API acts as the owner agent with its own
 * key; RBAC and the session kind decide who may read and write.
 */
export const objectsHttp: Scenario = {
  name: "objects-http",
  order: 599,
  async run(ctx) {
    const ownKey = `af_own_objhttp_${ctx.nonce}`;
    const serviceKey = `af_service_objhttp_${ctx.nonce}`;
    const org = `org-objhttp-${ctx.nonce}`;
    const drive = `drive-objhttp-${ctx.nonce}`;
    const foreignDrive = `drive-objhttp-foreign-${ctx.nonce}`;
    const files = new Map<string, { body: string; version: number }>();
    const hooks: Array<{ id: string; url: string }> = [];
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
        const rejected = agentFsRawJsonRejection(request);
        if (rejected) return rejected;
        if (request.method === "GET") {
          return current
            ? new Response(current.body, {
                headers: { "x-agent-fs-version": String(current.version) },
              })
            : new Response("not found", { status: 404 });
        }
        if (request.headers.get("if-none-match") === "*" && current) {
          return new Response("exists", { status: 409 });
        }
        const ifMatch = request.headers.get("if-match");
        if (ifMatch && String(current?.version) !== ifMatch) {
          return new Response("version mismatch", { status: 409 });
        }
        const version = (current?.version ?? 0) + 1;
        files.set(path, { body, version });
        return Response.json({ path, version });
      }
      if (url.pathname === `/orgs/${org}/ops`) {
        const op = JSON.parse(body) as Record<string, unknown>;
        if (op.op === "stat") {
          const current = files.get(String(op.path).replace(/^\/+/, ""));
          return current
            ? Response.json({ currentVersion: current.version })
            : new Response("not found", { status: 404 });
        }
        if (op.op === "webhook-list") return Response.json({ webhooks: hooks });
        if (op.op === "webhook-create") {
          const hook = { id: `hook-objhttp-${ctx.nonce}`, url: String(op.url) };
          hooks.push(hook);
          return Response.json({
            ...hook,
            eventTypes: op.eventTypes,
            secret: `whsec_${Buffer.from("e2e-objhttp-webhook-secret-32byt").toString("base64")}`,
          });
        }
        return new Response("unsupported op", { status: 400 });
      }
      return new Response("not found", { status: 404 });
    });

    const owner = await registerAgent(ctx, "objhttp-owner");
    const foreign = await registerAgent(ctx, "objhttp-foreign");
    const keyless = await registerAgent(ctx, "objhttp-keyless");
    const globalIds: string[] = [];
    const agentIds: string[] = [];
    const pageIds: string[] = [];
    const ownAgentFs = async (agentId: string, driveId: string) => {
      const ids: string[] = [];
      for (const [key, value] of [
        ["AGENT_FS_API_KEY", ownKey],
        ["AGENT_FS_API_URL", stub.origin],
        ["AGENT_FS_DEFAULT_ORG_ID", org],
        ["AGENT_FS_DEFAULT_DRIVE_ID", driveId],
      ] as const) {
        ids.push(await setConfig(ctx, "agent", agentId, key, value));
      }
      agentIds.push(...ids);
      return ids;
    };
    const writesSince = (from: number) =>
      stub.seen.slice(from).filter((entry) => entry.method === "PUT");
    try {
      // The swarm's shared drive is the global default drive.
      globalIds.push(await setConfig(ctx, "global", null, "AGENT_FS_DEFAULT_ORG_ID", org));
      globalIds.push(await setConfig(ctx, "global", null, "AGENT_FS_DEFAULT_DRIVE_ID", drive));
      await ownAgentFs(owner, drive);
      await ownAgentFs(foreign, foreignDrive);
      const keylessIds = await ownAgentFs(keyless, drive);

      const create = async (agentId: string, tool: string, path: string) =>
        withMcp(ctx, agentId, async (mcp) =>
          asString(
            asRecord(structured(await callToolOk(mcp, tool, { path })).object).id,
            `${tool} id`,
          ),
        );
      const sheetPath = `qa/objhttp-${ctx.nonce}.sheet.json`;
      const boardPath = `qa/objhttp-${ctx.nonce}.excalidraw`;
      const sheetId = await create(owner, "sheet-create", sheetPath);
      const boardId = await create(owner, "board-create", boardPath);
      const foreignId = await create(
        foreign,
        "board-create",
        `qa/objhttp-foreign-${ctx.nonce}.excalidraw`,
      );
      const keylessId = await create(
        keyless,
        "sheet-create",
        `qa/objhttp-keyless-${ctx.nonce}.sheet.json`,
      );

      // A signed-in person: a user-bound aswt_ token.
      const userName = `Objects viewer ${ctx.nonce}`;
      const createdUser = await ctx.api("POST", "/api/users", {
        body: { name: userName, status: "active" },
      });
      expectStatus(createdUser, [200], "create user");
      const userId = asString(asRecord(asRecord(createdUser.json).user).id, "user id");
      const minted = await ctx.api("POST", `/api/users/${userId}/mcp-tokens`, {
        body: { label: `objhttp ${ctx.nonce}` },
      });
      expectStatus(minted, [200], "mint a user token");
      const token = asString(asRecord(minted.json).plaintext, "user token");
      const asPerson = { apiKey: token } as const;
      const editorOf = (id: string) =>
        ctx.db.get<{ updated_by: string | null }>(
          "SELECT updated_by FROM primitive_objects WHERE id = ?",
          [id],
        )?.updated_by;

      // ── read ────────────────────────────────────────────────────────────────────────────────
      let response = await ctx.api("GET", `/api/objects/${sheetId}`, asPerson);
      expectStatus(response, [200], "a user reads a sheet");
      let body = asRecord(response.json);
      expect(
        body.unchanged === false &&
          body.version === 1 &&
          asRecord(body.content).format === "swarm-sheet/1" &&
          asRecord(body.object).path === sheetPath &&
          asRecord(body.object).kind === "sheet",
        `read: ${JSON.stringify(body).slice(0, 300)}`,
      );
      expectStatus(
        await ctx.api("GET", `/api/objects/${crypto.randomUUID()}`, asPerson),
        [404],
        "an unknown object id",
      );
      expectStatus(
        await ctx.api("GET", "/api/objects/not-a-uuid", asPerson),
        [400],
        "an id that is not a uuid",
      );
      expectStatus(
        await ctx.api("GET", `/api/objects/${sheetId}`, { apiKey: null }),
        [401],
        "no auth",
      );

      // knownVersion without webhooks: one agent-fs stat, no download.
      let from = stub.seen.length;
      response = await ctx.api("GET", `/api/objects/${sheetId}?knownVersion=1`, asPerson);
      expectStatus(response, [200], "knownVersion at the current version");
      body = asRecord(response.json);
      const statOnly = stub.seen.slice(from);
      expect(
        body.unchanged === true && body.version === 1 && body.content === undefined,
        `unchanged: ${JSON.stringify(body).slice(0, 200)}`,
      );
      expect(
        statOnly.length === 1 && statOnly[0]?.body.includes('"op":"stat"'),
        `one stat call: ${JSON.stringify(statOnly.map((e) => `${e.method} ${e.path} ${e.body}`))}`,
      );
      response = await ctx.api("GET", `/api/objects/${sheetId}?knownVersion=0`, asPerson);
      expect(
        asRecord(response.json).unchanged === false &&
          asRecord(response.json).content !== undefined,
        "an older knownVersion gets the content",
      );

      // ── sheet ops ───────────────────────────────────────────────────────────────────────────
      response = await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
        ...asPerson,
        body: { op: "setRange", range: "B2:C2", values: [[2, "=B2*3"]] },
      });
      expectStatus(response, [200], "a user sets cells");
      body = asRecord(response.json);
      expect(
        body.op === "setRange" &&
          body.range === "Sheet1!B2:C2" &&
          body.changed === 2 &&
          body.version === 2,
        `setRange: ${JSON.stringify(body)}`,
      );
      const storedCells = (): Record<string, unknown> =>
        asRecord(
          asRecord((asRecord(JSON.parse(files.get(sheetPath)?.body ?? "{}")).tabs as unknown[])[0])
            .cells,
        );
      expect(
        JSON.stringify(storedCells().C2) === `{"f":"=B2*3","v":6}`,
        `the formula recomputed server-side: ${JSON.stringify(storedCells())}`,
      );
      expect(editorOf(sheetId) === userId, "the row records the user as the editor");
      response = await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
        ...asPerson,
        body: { op: "appendRows", tab: "Sheet1", rows: [["total", "=B2+1"]] },
      });
      expectStatus(response, [200], "a user appends rows");
      expect(asRecord(response.json).range === "Sheet1!A3:B3", `append: ${response.text}`);
      response = await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
        ...asPerson,
        body: { op: "clearRange", range: "A3:B3" },
      });
      expectStatus(response, [200], "a user clears a range");
      expect(asRecord(response.json).cleared === 2, `clear: ${response.text}`);
      expectStatus(
        await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
          ...asPerson,
          body: { op: "setRange", range: "not a range", values: [[1]] },
        }),
        [400],
        "a bad range",
      );
      expectStatus(
        await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
          ...asPerson,
          body: { op: "renameTab", name: "x" },
        }),
        [400],
        "an unknown op",
      );
      expectStatus(
        await ctx.api("POST", `/api/objects/${boardId}/sheet-ops`, {
          ...asPerson,
          body: { op: "clearRange", range: "A1" },
        }),
        [400],
        "sheet ops on a board",
      );
      // The dashboard: operator key plus the user it picked; without one, no editor is recorded.
      response = await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
        headers: { "X-Swarm-User-Id": userId },
        body: { op: "setRange", range: "D1", values: [["dash"]] },
      });
      expectStatus(response, [200], "the dashboard sets a cell");
      expect(editorOf(sheetId) === userId, "the dashboard's picked user is the editor");
      response = await ctx.api("POST", `/api/objects/${sheetId}/sheet-ops`, {
        body: { op: "setRange", range: "D1", values: [["op"]] },
      });
      expectStatus(response, [200], "the operator key sets a cell");
      expect(editorOf(sheetId) === null, "a write with no person clears the editor");

      // ── board save ──────────────────────────────────────────────────────────────────────────
      response = await ctx.api("GET", `/api/objects/${boardId}`, asPerson);
      expectStatus(response, [200], "a user reads a board");
      const boardVersion = Number(asRecord(response.json).version);
      const scene = asRecord(asRecord(response.json).content);
      const element = {
        id: `el-${ctx.nonce}`,
        type: "rectangle",
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      };
      // A stock Excalidraw save drops `swarm`; the route puts the id back.
      const { swarm: _dropped, ...stock } = scene;
      from = stub.seen.length;
      response = await ctx.api("PUT", `/api/objects/${boardId}/content`, {
        ...asPerson,
        body: { content: { ...stock, elements: [element] }, ifMatch: boardVersion },
      });
      expectStatus(response, [200], "a user saves a board");
      expect(asRecord(response.json).version === boardVersion + 1, `save: ${response.text}`);
      const saved = JSON.parse(files.get(boardPath)?.body ?? "{}") as Record<string, unknown>;
      expect(
        asRecord(saved.swarm).id === boardId && (saved.elements as unknown[]).length === 1,
        `stored board keeps its id: ${JSON.stringify(saved).slice(0, 300)}`,
      );
      const put = writesSince(from)[0];
      expect(
        put?.headers["x-agent-fs-message"] === `edit via app by ${userName}` &&
          put.headers.authorization === `Bearer ${ownKey}`,
        `the save is the owner's key with the editor's name: ${JSON.stringify(put?.headers)}`,
      );
      expect(editorOf(boardId) === userId, "the board row records the editor");
      response = await ctx.api("PUT", `/api/objects/${boardId}/content`, {
        ...asPerson,
        body: { content: { ...stock, elements: [] }, ifMatch: boardVersion },
      });
      expectStatus(response, [409], "a stale save");
      expect(
        asRecord(response.json).version === boardVersion + 1,
        `the 409 carries the current version: ${response.text}`,
      );
      expectStatus(
        await ctx.api("PUT", `/api/objects/${boardId}/content`, {
          ...asPerson,
          body: { content: { elements: [{ type: "rectangle" }] }, ifMatch: boardVersion + 1 },
        }),
        [400],
        "an element without an id",
      );
      expectStatus(
        await ctx.api("PUT", `/api/objects/${sheetId}/content`, {
          ...asPerson,
          body: { content: { elements: [] }, ifMatch: 1 },
        }),
        [400],
        "a full save on a sheet",
      );

      // ── refusals by drive and owner ─────────────────────────────────────────────────────────
      response = await ctx.api("GET", `/api/objects/${foreignId}`, asPerson);
      expectStatus(response, [403], "an object off the shared drive");
      for (const id of keylessIds.slice(0, 1)) await ctx.api("DELETE", `/api/config/${id}`);
      response = await ctx.api("GET", `/api/objects/${keylessId}`, asPerson);
      expectStatus(response, [503], "an owner with no agent-fs key");
      expect(
        asRecord(response.json).error === "owner agent has no agent-fs key",
        `503 reason: ${response.text}`,
      );

      // ── page sessions ───────────────────────────────────────────────────────────────────────
      const createPage = async (authMode: string, extra: Record<string, unknown> = {}) => {
        const created = await ctx.api("POST", "/api/pages", {
          agentId: owner,
          body: {
            slug: `objhttp-${authMode}-${ctx.nonce}`,
            title: `Objects ${authMode}`,
            contentType: "text/html",
            authMode,
            body: "<p>embed</p>",
            ...extra,
          },
        });
        expectStatus(created, [201], `create a ${authMode} page`);
        const id = asString(asRecord(created.json).id, "page id");
        pageIds.push(id);
        return id;
      };
      const viaPage = (pageId: string, cookie: string) =>
        ({ apiKey: null, headers: { Cookie: cookie, "X-Swarm-Page-Id": pageId } }) as const;
      const authed = await createPage("authed");

      // A page launched with the operator key reads, never writes.
      let launch = await ctx.api("POST", `/api/pages/${authed}/launch`);
      expectStatus(launch, [204], "operator launch");
      const operatorSession = viaPage(authed, cookiePair(launch.headers));
      expectStatus(
        await ctx.api("GET", `/@swarm/api/objects/${sheetId}`, operatorSession),
        [200],
        "an operator page session reads",
      );
      response = await ctx.api("POST", `/@swarm/api/objects/${sheetId}/sheet-ops`, {
        ...operatorSession,
        body: { op: "setRange", range: "E1", values: [[1]] },
      });
      expectStatus(response, [403], "an operator page session cannot write");
      expect(String(asRecord(response.json).error).includes("read-only"), response.text);

      // A page launched by a signed-in user writes as that user.
      launch = await ctx.api("POST", `/api/pages/${authed}/launch`, asPerson);
      expectStatus(launch, [204], "user launch");
      const userSession = viaPage(authed, cookiePair(launch.headers));
      response = await ctx.api("GET", `/@swarm/api/objects/${boardId}`, userSession);
      expectStatus(response, [200], "a user page session reads");
      from = stub.seen.length;
      response = await ctx.api("PUT", `/@swarm/api/objects/${boardId}/content`, {
        ...userSession,
        body: {
          content: { ...stock, elements: [] },
          ifMatch: Number(asRecord(response.json).version),
        },
      });
      expectStatus(response, [200], "a user page session saves");
      expect(
        writesSince(from)[0]?.headers["x-agent-fs-message"] === `edit via page by ${userName}`,
        "a page save names the page and the user",
      );

      // A password-page guest is refused before any agent-fs call.
      const password = `pw-${ctx.nonce}`;
      const locked = await createPage("password", { password });
      const guest = await ctx.api("GET", `/p/${locked}?key=${encodeURIComponent(password)}`, {
        apiKey: null,
      });
      expectStatus(guest, [200], "open the password page");
      from = stub.seen.length;
      response = await ctx.api(
        "GET",
        `/@swarm/api/objects/${sheetId}`,
        viaPage(locked, cookiePair(guest.headers)),
      );
      expectStatus(response, [403], "a password guest is refused");
      expect(stub.seen.length === from, "a refused guest reaches no agent-fs");

      // ── knownVersion with webhooks: the row answers, no agent-fs call ──────────────────────
      globalIds.push(await setConfig(ctx, "global", null, "AGENT_FS_API_URL", stub.origin));
      globalIds.push(await setConfig(ctx, "global", null, "API_AGENT_FS_API_KEY", serviceKey));
      // Creating an object asks agent-fs to watch its drive (object-webhooks.ts).
      await create(owner, "board-create", `qa/objhttp-watch-${ctx.nonce}.excalidraw`);
      const watched = () =>
        ctx.db.get<{ status: string }>(
          "SELECT status FROM agent_fs_object_webhooks WHERE orgId = ? AND driveId = ?",
          [org, drive],
        )?.status === "active";
      const deadline = Date.now() + 10_000;
      while (!watched() && Date.now() < deadline) await Bun.sleep(100);
      expect(watched(), `the shared drive's webhook is active: ${JSON.stringify(hooks)}`);
      const fresh = ctx.db.get<{ fileVersion: number }>(
        "SELECT fileVersion FROM primitive_objects WHERE id = ?",
        [sheetId],
      )?.fileVersion;
      from = stub.seen.length;
      response = await ctx.api("GET", `/api/objects/${sheetId}?knownVersion=${fresh}`, asPerson);
      expectStatus(response, [200], "knownVersion on a watched drive");
      expect(
        asRecord(response.json).unchanged === true && stub.seen.length === from,
        `a fresh row answers with no agent-fs call: ${JSON.stringify(stub.seen.slice(from).map((e) => e.path))}`,
      );
    } finally {
      for (const id of pageIds) await ctx.api("DELETE", `/api/pages/${id}`, { agentId: owner });
      for (const id of [...agentIds, ...globalIds]) await ctx.api("DELETE", `/api/config/${id}`);
      stub.stop();
    }
  },
};
