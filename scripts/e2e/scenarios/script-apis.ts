import { asRecord, asRecords, asString, expect, expectStatus } from "../http";
import type { Scenario, ScenarioContext } from "../run";
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

type Called = { status: number; body: Record<string, unknown>; text: string };

/** POST the public endpoint. The route is outside the API key scheme, so use a raw fetch. */
async function callPublic(
  ctx: ScenarioContext,
  endpointId: string,
  options: { token?: string | null; body?: unknown; rawBody?: string } = {},
): Promise<Called> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const started = performance.now();
  const response = await fetch(`${ctx.baseUrl}/api/x/script/${endpointId}`, {
    method: "POST",
    headers,
    body: options.rawBody ?? JSON.stringify(options.body ?? {}),
  });
  const text = await response.text();
  ctx.recordHttpCall(
    "POST",
    `/api/x/script/${endpointId}`,
    response.status,
    performance.now() - started,
  );
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(JSON.parse(text));
  } catch {
    body = {};
  }
  return { status: response.status, body, text };
}

function expectUnauthorized(called: Called, label: string): void {
  expect(
    called.status === 401 && asRecord(called.body.error).type === "unauthorized",
    `${label}: expected the nested 401 envelope, got ${called.status} ${called.text.slice(0, 200)}`,
  );
}

function expectNotFound(called: Called, label: string): void {
  expect(
    called.status === 404 && asRecord(called.body.error).type === "not_found",
    `${label}: expected the nested 404 envelope, got ${called.status} ${called.text.slice(0, 200)}`,
  );
}

/**
 * Flow `script-apis`: expose a saved script as a public HTTP endpoint (bearer or no auth),
 * reveal / rotate / disable / relabel / delete it, and call it for real at
 * POST /api/x/script/{id}. Also the lead-gated `script-apis` MCP tool.
 */
export const scriptApis: Scenario = {
  name: "script-apis",
  order: 470,
  async run(ctx) {
    const ownerId = await registerAgent(ctx, "apis");
    const leadId = await getLead(ctx);
    const scriptName = `e2e-api-${ctx.nonce}`;
    const source = `import { z } from "zod";
export const argsSchema = z.object({ n: z.number(), note: z.string().optional() });
export default async function (args: z.infer<typeof argsSchema>, ctx: any) {
  if (args.note === "explode") throw new Error("exploded-${ctx.nonce}");
  const me = await ctx.swarm.agent_info({});
  return { doubled: args.n * 2, note: args.note ?? null, runAs: me.data.id };
}`;
    const script = await upsertScript(ctx, ownerId, {
      name: scriptName,
      source,
      description: "public endpoint target",
    });
    const scriptId = script.id;

    // ── create: bearer (default) and none ──
    const created = await ctx.api("POST", `/api/scripts/${scriptId}/apis`, {
      body: { label: "primary" },
    });
    expectStatus(created, [201], "create a bearer endpoint");
    const endpoint = asRecord(created.json);
    const endpointId = asString(endpoint.id, "endpoint id");
    const token = asString(endpoint.token, "endpoint token");
    expect(/^[a-zA-Z]{12}$/.test(endpointId), `endpoint ids are 12 letters, got ${endpointId}`);
    expect(
      endpoint.scriptId === scriptId &&
        endpoint.agentId === ownerId &&
        endpoint.authMode === "bearer" &&
        endpoint.enabled === true &&
        endpoint.label === "primary" &&
        endpoint.callCount === 0 &&
        endpoint.lastUsedAt === null &&
        token.startsWith("xsk_"),
      `endpoint record is wrong: ${created.text.replace(token, "<token>")}`,
    );
    const open = await ctx.api("POST", `/api/scripts/${scriptId}/apis`, {
      body: { authMode: "none", label: "open", agentId: ownerId },
    });
    expectStatus(open, [201], "create a no-auth endpoint");
    const openEndpoint = asRecord(open.json);
    const openId = asString(openEndpoint.id, "open endpoint id");
    expect(
      openEndpoint.authMode === "none" && openEndpoint.token === null,
      "none auth has no token",
    );
    expectStatus(
      await ctx.api("POST", `/api/scripts/00000000-0000-4000-8000-000000000000/apis`, { body: {} }),
      [404],
      "create for an unknown script",
    );
    expectStatus(
      await ctx.api("POST", `/api/scripts/${scriptId}/apis`, { body: { authMode: "basic" } }),
      [400],
      "create with an unknown auth mode",
    );
    const dbEndpoint = ctx.db.get<{ authMode: string; enabled: number; hasToken: number }>(
      "SELECT authMode, enabled, bearerTokenEncrypted IS NOT NULL AS hasToken FROM script_apis WHERE id = ?",
      [endpointId],
    );
    expect(
      dbEndpoint?.authMode === "bearer" && dbEndpoint.enabled === 1 && dbEndpoint.hasToken === 1,
      "the endpoint row must hold an encrypted token",
    );
    const plaintextInDb = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM script_apis WHERE bearerTokenEncrypted = ?",
      [token],
    );
    expect(plaintextInDb?.n === 0, "the bearer token must not be stored in plaintext");

    // ── list never carries tokens; reveal returns them ──
    const listed = await ctx.api("GET", `/api/scripts/${scriptId}/apis`);
    expectStatus(listed, [200], "list endpoints");
    const apis = asRecords(listed.json, "apis");
    expect(
      apis.length === 2 && apis.every((item) => !("token" in item)),
      "the endpoint list must not include tokens",
    );
    expectStatus(
      await ctx.api("GET", "/api/scripts/00000000-0000-4000-8000-000000000000/apis"),
      [404],
      "list for an unknown script",
    );
    const revealed = await ctx.api("GET", `/api/scripts/${scriptId}/apis/${endpointId}/secret`);
    expectStatus(revealed, [200], "reveal the token");
    expect(asRecord(revealed.json).token === token, "reveal must return the issued token");
    const noSecret = await ctx.api("GET", `/api/scripts/${scriptId}/apis/${openId}/secret`);
    expect(asRecord(noSecret.json).token === null, "a no-auth endpoint has no secret");
    expectStatus(
      await ctx.api("GET", `/api/scripts/${scriptId}/apis/nopenopenope/secret`),
      [404],
      "reveal an unknown endpoint",
    );
    expectStatus(
      await ctx.api(
        "GET",
        `/api/scripts/00000000-0000-4000-8000-000000000000/apis/${endpointId}/secret`,
      ),
      [404],
      "reveal through the wrong script id",
    );

    // ── calling the public endpoint ──
    const ok = await callPublic(ctx, endpointId, { token, body: { n: 21, note: "hi" } });
    expect(
      ok.status === 200 && ok.body.ok === true && ok.body.error === null,
      `call failed: ${ok.text}`,
    );
    expect(
      JSON.stringify(ok.body.result) ===
        JSON.stringify({ doubled: 42, note: "hi", runAs: ownerId }) &&
        typeof ok.body.durationMs === "number",
      `the script must run as the endpoint's agent: ${ok.text}`,
    );
    expectUnauthorized(await callPublic(ctx, endpointId, { body: { n: 1 } }), "no token");
    expectUnauthorized(
      await callPublic(ctx, endpointId, { token: "xsk_wrong", body: { n: 1 } }),
      "wrong token",
    );
    expectNotFound(
      await callPublic(ctx, "doesNotExist", { token, body: { n: 1 } }),
      "unknown endpoint",
    );
    const badJson = await callPublic(ctx, endpointId, { token, rawBody: "{not json" });
    expect(
      badJson.status === 200 &&
        badJson.body.ok === false &&
        asRecord(badJson.body.error).type === "invalid_json",
      `invalid JSON must be reported in the envelope: ${badJson.text}`,
    );
    const badArgs = await callPublic(ctx, endpointId, { token, body: { n: "twenty" } });
    const badArgsError = asRecord(badArgs.body.error);
    expect(
      badArgs.status === 200 &&
        badArgs.body.ok === false &&
        badArgsError.type === "args_validation" &&
        Array.isArray(badArgsError.details) &&
        String(badArgsError.details[0]).includes("n"),
      `args are validated against the stored schema: ${badArgs.text}`,
    );
    const exploded = await callPublic(ctx, endpointId, { token, body: { n: 1, note: "explode" } });
    expect(
      exploded.status === 200 &&
        exploded.body.ok === false &&
        asRecord(exploded.body.error).type === "runtime_error" &&
        String(asRecord(exploded.body.error).message).includes(`exploded-${ctx.nonce}`),
      `a throwing script must be a runtime_error envelope: ${exploded.text}`,
    );
    const tooBig = await callPublic(ctx, endpointId, {
      token,
      rawBody: JSON.stringify({ n: 1, note: "x".repeat(1_100_000) }),
    });
    expect(
      tooBig.status === 413,
      `a body above 1 MiB must be refused with 413, got ${tooBig.status}`,
    );
    const anonymous = await callPublic(ctx, openId, { body: { n: 4 } });
    expect(
      anonymous.status === 200 && asRecord(anonymous.body.result).doubled === 8,
      "a no-auth endpoint runs without a token",
    );

    // usage counters
    const used = asRecords(
      await ctx.api("GET", `/api/scripts/${scriptId}/apis`).then((r) => r.json),
      "apis",
    );
    const usedPrimary = used.find((item) => item.id === endpointId);
    expect(
      Number(usedPrimary?.callCount) >= 2 && typeof usedPrimary?.lastUsedAt === "string",
      `callCount and lastUsedAt must track runs: ${JSON.stringify(usedPrimary)}`,
    );
    const endpointRuns = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM script_runs WHERE apiEndpointId = ?",
      [endpointId],
    );
    expect(Number(endpointRuns?.n) >= 2, "endpoint calls must be recorded as runs");

    // FINDING: a Zod `.default()` field is optional to the script but the stored args JSON
    // schema marks it required (it is the *output* shape), so the public endpoint rejects a
    // call that omits it with args_validation although the script would accept the call.
    const defaulted = await upsertScript(ctx, ownerId, {
      name: `e2e-api-default-${ctx.nonce}`,
      source: `import { z } from "zod";
export const argsSchema = z.object({ n: z.number(), scale: z.number().default(2) });
export default async function (args: z.infer<typeof argsSchema>) { return args.n * args.scale; }`,
    });
    const defaultedEndpoint = asRecord(
      (await ctx.api("POST", `/api/scripts/${defaulted.id}/apis`, { body: {} })).json,
    );
    const omitted = await callPublic(ctx, String(defaultedEndpoint.id), {
      token: String(defaultedEndpoint.token),
      body: { n: 3 },
    });
    expect(
      omitted.body.ok === false && asRecord(omitted.body.error).type === "args_validation",
      `FINDING changed: a defaulted field is no longer required by the endpoint: ${omitted.text}`,
    );
    const explicit = await callPublic(ctx, String(defaultedEndpoint.id), {
      token: String(defaultedEndpoint.token),
      body: { n: 3, scale: 4 },
    });
    expect(
      explicit.body.ok === true && explicit.body.result === 12,
      "explicit defaults still work",
    );

    // ── rotate: the old token dies, the new one works ──
    const rotated = await ctx.api("POST", `/api/scripts/${scriptId}/apis/${endpointId}/rotate`);
    expectStatus(rotated, [200], "rotate");
    const rotatedBody = asRecord(rotated.json);
    const newToken = asString(rotatedBody.token, "rotated token");
    expect(
      newToken !== token && newToken.startsWith("xsk_") && rotatedBody.id === endpointId,
      "rotate must issue a new token for the same endpoint",
    );
    expectUnauthorized(
      await callPublic(ctx, endpointId, { token, body: { n: 1 } }),
      "rotated-out token",
    );
    const afterRotate = await callPublic(ctx, endpointId, { token: newToken, body: { n: 2 } });
    expect(afterRotate.body.ok === true, "the rotated token must work");
    const revealedNew = await ctx.api("GET", `/api/scripts/${scriptId}/apis/${endpointId}/secret`);
    expect(asRecord(revealedNew.json).token === newToken, "reveal must return the rotated token");
    const rotateNone = await ctx.api("POST", `/api/scripts/${scriptId}/apis/${openId}/rotate`);
    expectStatus(rotateNone, [400], "rotate a no-auth endpoint");
    expectStatus(
      await ctx.api("POST", `/api/scripts/${scriptId}/apis/nopenopenope/rotate`),
      [404],
      "rotate unknown",
    );

    // ── patch: disable hides the endpoint, relabel, re-enable ──
    const disabled = await ctx.api("PATCH", `/api/scripts/${scriptId}/apis/${endpointId}`, {
      body: { enabled: false, label: "renamed" },
    });
    expectStatus(disabled, [200], "disable and relabel");
    expect(
      asRecord(disabled.json).enabled === false && asRecord(disabled.json).label === "renamed",
      "patch must apply both fields",
    );
    expectNotFound(
      await callPublic(ctx, endpointId, { token: newToken, body: { n: 1 } }),
      "a disabled endpoint is indistinguishable from an unknown one",
    );
    const cleared = await ctx.api("PATCH", `/api/scripts/${scriptId}/apis/${endpointId}`, {
      body: { enabled: true, label: null },
    });
    expect(
      asRecord(cleared.json).enabled === true && asRecord(cleared.json).label === null,
      "patch with label:null must clear the label",
    );
    expect(
      (await callPublic(ctx, endpointId, { token: newToken, body: { n: 1 } })).body.ok === true,
      "a re-enabled endpoint must answer again",
    );
    expectStatus(
      await ctx.api(
        "PATCH",
        `/api/scripts/00000000-0000-4000-8000-000000000000/apis/${endpointId}`,
        {
          body: { enabled: true },
        },
      ),
      [404],
      "patch through the wrong script id",
    );
    expectStatus(
      await ctx.api("PATCH", `/api/scripts/${scriptId}/apis/nopenopenope`, { body: {} }),
      [404],
      "patch unknown",
    );

    // ── the lead-gated `script-apis` MCP tool ──
    const toolEndpoint = await withMcp(ctx, leadId, async (mcp) => {
      const made = await callToolOk(mcp, "script-apis", {
        action: "create",
        scriptId,
        label: "from-tool",
        agentId: ownerId,
      });
      const madeData = asRecord(structured(made).data);
      const toolToken = asString(madeData.token, "tool token");
      const toolEndpointId = asString(madeData.id, "tool endpoint id");
      expect(
        toolText(made).includes(toolToken) && madeData.authMode === "bearer",
        "create must show the token once",
      );
      expect(
        (await callPublic(ctx, toolEndpointId, { token: toolToken, body: { n: 5 } })).body.ok ===
          true,
        "an endpoint created through the tool must be callable",
      );

      const revealedList = await callToolOk(mcp, "script-apis", {
        action: "list",
        scriptId,
        includeSecrets: true,
      });
      const revealedEndpoints = asRecords(asRecord(structured(revealedList).data), "apis");
      expect(
        revealedEndpoints.find((item) => item.id === toolEndpointId)?.token === toolToken &&
          revealedEndpoints.find((item) => item.id === endpointId)?.token === newToken,
        "a lead can reveal tokens with includeSecrets",
      );
      const updated = await callToolOk(mcp, "script-apis", {
        action: "update",
        scriptId,
        endpointId: toolEndpointId,
        enabled: false,
        label: "tool-renamed",
      });
      expect(toolText(updated).includes("Endpoint updated"), "update text");
      expectNotFound(
        await callPublic(ctx, toolEndpointId, { token: toolToken, body: { n: 1 } }),
        "tool-disabled endpoint",
      );
      const toolRotated = await callToolOk(mcp, "script-apis", {
        action: "rotate",
        scriptId,
        endpointId: toolEndpointId,
      });
      expect(
        asString(asRecord(structured(toolRotated).data).token, "rotated tool token") !== toolToken,
        "rotate through the tool must issue a new token",
      );
      for (const action of ["rotate", "update", "delete"] as const) {
        const missing = await callToolErr(mcp, "script-apis", { action, scriptId });
        expect(toolText(missing).includes("endpointId is required"), `${action} needs endpointId`);
      }
      return toolEndpointId;
    });

    await withMcp(ctx, ownerId, async (mcp) => {
      const listed = await callToolOk(mcp, "script-apis", { action: "list", scriptId });
      const masked = asRecords(asRecord(structured(listed).data), "apis");
      expect(
        masked.length >= 3 &&
          masked
            .filter((item) => item.authMode === "bearer")
            .every((item) => item.token === "********") &&
          !toolText(listed).includes(newToken),
        "a worker sees masked tokens only",
      );
      const revealDenied = await callToolErr(mcp, "script-apis", {
        action: "list",
        scriptId,
        includeSecrets: true,
      });
      expect(
        toolText(revealDenied).includes("Only lead agents can reveal script API bearer tokens"),
        "includeSecrets is lead-only",
      );
      for (const [action, message] of [
        ["create", "create script API endpoints"],
        ["update", "update script API endpoints"],
        ["rotate", "rotate script API bearer tokens"],
        ["delete", "delete script API endpoints"],
      ] as const) {
        const denied = await callToolErr(mcp, "script-apis", {
          action,
          scriptId,
          endpointId: toolEndpoint,
        });
        expect(
          toolText(denied).includes(`Only lead agents can ${message}`) &&
            structured(denied).status === 403,
          `${action} must be lead-only`,
        );
      }
    });

    // ── delete: gone for good; deleting the script removes its endpoints ──
    const deleted = await ctx.api("DELETE", `/api/scripts/${scriptId}/apis/${endpointId}`);
    expectStatus(deleted, [200], "delete endpoint");
    expect(JSON.stringify(deleted.json) === JSON.stringify({ deleted: true }), "delete response");
    expectNotFound(
      await callPublic(ctx, endpointId, { token: newToken, body: { n: 1 } }),
      "a deleted endpoint",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/scripts/${scriptId}/apis/${endpointId}`),
      [404],
      "delete again",
    );
    expectStatus(
      await ctx.api("DELETE", `/api/scripts/00000000-0000-4000-8000-000000000000/apis/${openId}`),
      [404],
      "delete through the wrong script id",
    );
    await withMcp(ctx, leadId, async (mcp) => {
      const gone = await callToolOk(mcp, "script-apis", {
        action: "delete",
        scriptId,
        endpointId: toolEndpoint,
      });
      expect(toolText(gone).includes("Endpoint deleted"), "tool delete text");
    });
    const removedScript = await ctx.api("DELETE", `/api/scripts/${scriptName}?scope=agent`, {
      agentId: ownerId,
    });
    expect(asRecord(removedScript.json).deleted === true, "delete the script");
    const orphans = ctx.db.get<{ n: number }>(
      "SELECT count(*) AS n FROM script_apis WHERE scriptId = ?",
      [scriptId],
    );
    expect(orphans?.n === 0, "deleting a script must delete its endpoints");
    expectNotFound(
      await callPublic(ctx, openId, { body: { n: 1 } }),
      "endpoint of a deleted script",
    );
    await ctx.api("DELETE", `/api/scripts/e2e-api-default-${ctx.nonce}?scope=agent`, {
      agentId: ownerId,
    });
  },
};
