import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import { Readable } from "node:stream";
import { closeDb, getSwarmConfigs, initDb, upsertSwarmConfig } from "../be/db";
import { handleConfig } from "../http/config";
import { handleRanking } from "../http/ranking";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { parseTelemetryRanking } from "../ranking/telemetry-ranking";
import { _resetTelemetryStateForTests, initTelemetry } from "../telemetry";
import type { HttpRequestAuth } from "../utils/request-auth-context";
import { setRequestAuth } from "../utils/request-auth-context";

const TEST_DB_PATH = "./test-ranking-route.sqlite";
const OPERATOR: HttpRequestAuth = { kind: "operator", fingerprint: "op:test" };
const INSTALL_ID = "install_0123456789abcdef0123456789abcdef";
const ENV_KEYS = [
  "ANONYMIZED_TELEMETRY",
  "SWARM_ORG_ID",
  "SWARM_ORG_NAME",
  "SWARM_ORG_WEBSITE",
  "PUBLIC_RANKING_ENABLED",
] as const;

async function removeDbFiles(): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(TEST_DB_PATH + suffix);
    } catch {
      // Not there.
    }
  }
}

type Handler = typeof handleRanking;

async function call(
  method: string,
  url: string,
  body?: unknown,
  handler: Handler = handleRanking,
  auth: HttpRequestAuth = OPERATOR,
): Promise<{ statusCode: number; json: Record<string, unknown> }> {
  const req = Readable.from(
    body === undefined ? [] : [Buffer.from(JSON.stringify(body))],
  ) as Readable & {
    method: string;
    url: string;
    headers: Record<string, string>;
  };
  req.method = method;
  req.url = url;
  req.headers = { "content-type": "application/json" };
  setRequestAuth(req as never, auth);
  let statusCode = 200;
  const chunks: string[] = [];
  const res = {
    setHeader: () => {},
    writeHead: (code: number) => {
      statusCode = code;
    },
    end: (chunk?: string) => {
      if (chunk) chunks.push(chunk);
    },
  };
  await handler(req as never, res as never, getPathSegments(url), parseQueryParams(url));
  const text = chunks.join("");
  return { statusCode, json: text ? JSON.parse(text) : {} };
}

const configValue = async (key: string) =>
  (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value;

describe("ranking routes", () => {
  const originalFetch = globalThis.fetch;
  const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let sent: Array<{
    event: string;
    properties: Record<string, unknown>;
    context: Record<string, unknown>;
  }>;

  beforeAll(async () => {
    for (const key of ENV_KEYS) delete process.env[key];
    process.env.ANONYMIZED_TELEMETRY = "true";
    process.env.SWARM_ORG_ID = "org_0123456789abcdef";
    await removeDbFiles();
    initDb(TEST_DB_PATH);
    globalThis.fetch = (async (url: string, init?: { body?: string }) => {
      if (String(url).endsWith("/v1/events")) sent.push(JSON.parse(init?.body ?? "{}"));
      return new Response(null, { status: 202 });
    }) as unknown as typeof fetch;
    _resetTelemetryStateForTests();
    await initTelemetry(
      "api-server",
      async (key) => (key === "telemetry_installation_id" ? INSTALL_ID : undefined),
      async () => {},
    );
  });

  afterAll(async () => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    globalThis.fetch = originalFetch;
    _resetTelemetryStateForTests();
    closeDb();
    await removeDbFiles();
  });

  beforeEach(async () => {
    sent = [];
    process.env.ANONYMIZED_TELEMETRY = "true";
    await upsertSwarmConfig({
      scope: "global",
      key: "telemetry_installation_id",
      value: INSTALL_ID,
    });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Acme" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "acme.dev" });
    await upsertSwarmConfig({ scope: "global", key: "PUBLIC_RANKING_ENABLED", value: "false" });
    await upsertSwarmConfig({ scope: "global", key: "telemetry_ranking", value: "" });
  });

  const form = {
    category: "engineering",
    subcategory: "qa-testing",
    description: " QA ",
    sourceCodeUrl: "",
  };

  test("telemetry off is a 409 telemetry_off", async () => {
    process.env.ANONYMIZED_TELEMETRY = "false";
    const result = await call("POST", "/api/ranking/opt-in", form);
    expect(result.statusCode).toBe(409);
    expect(result.json.error).toBe("telemetry_off");
    expect(await configValue("PUBLIC_RANKING_ENABLED")).toBe("false");
  });

  test("a placeholder name and no website is a 409 that lists both", async () => {
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Swarm" });
    await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "" });
    const result = await call("POST", "/api/ranking/opt-in", form);
    expect(result.statusCode).toBe(409);
    expect(result.json).toMatchObject({
      error: "org_identity_missing",
      missing: ["SWARM_ORG_NAME", "SWARM_ORG_WEBSITE"],
    });
    const state = await call("GET", "/api/ranking");
    expect(state.json).toMatchObject({
      eligible: false,
      missing: ["SWARM_ORG_NAME", "SWARM_ORG_WEBSITE"],
    });
    expect(sent).toEqual([]);
  });

  test("a subcategory from another category is a 400", async () => {
    const result = await call("POST", "/api/ranking/opt-in", { ...form, subcategory: "seo" });
    expect(result.statusCode).toBe(400);
    expect(String(result.json.error)).toContain("subcategory");
  });

  test("opt-in stores the listing, turns the setting on and emits it with a matching envelope", async () => {
    const result = await call("POST", "/api/ranking/opt-in", form);
    expect(result.statusCode).toBe(200);
    const claim = String(result.json.claim);
    expect(claim).toMatch(/^rk_[0-9a-f]{32}$/);
    expect(result.json.domain).toBe("acme.dev");
    expect(String(result.json.prUrl)).toContain("filename=community%2Franking%2Facme.dev.json");
    expect(JSON.parse(String(result.json.fileJson))).toEqual({
      $schema: "./schema.json",
      domain: "acme.dev",
      claim,
    });
    expect(String(result.json.verifyUrl)).toBe(
      `https://proxy.desplega.sh/v1/ranking/verify?domain=acme.dev&claim=${claim}`,
    );

    const stored = parseTelemetryRanking(String(await configValue("telemetry_ranking")));
    expect(stored).toMatchObject({
      claim,
      name: "Acme",
      domain: "acme.dev",
      category: "engineering",
      subcategory: "qa-testing",
      description: "QA",
      sourceCodeUrl: null,
    });
    expect(await configValue("PUBLIC_RANKING_ENABLED")).toBe("true");

    expect(sent.map((event) => event.event)).toEqual(["ranking.opted_in"]);
    const listing = parseTelemetryRanking(String(sent[0]?.properties.listing));
    expect(listing).toEqual(stored);
    expect(sent[0]?.context).toMatchObject({ org_name: "Acme", org_website: "acme.dev" });

    // A second opt-in for the same domain keeps the claim.
    const again = await call("POST", "/api/ranking/opt-in", { category: "other" });
    expect(again.json.claim).toBe(claim);

    const state = await call("GET", "/api/ranking");
    expect(state.json).toMatchObject({
      eligible: true,
      enabled: true,
      missing: [],
      listingMatchesDomain: true,
    });
  });

  test("only a config admin reads the ranking state and its claim", async () => {
    const claim = String((await call("POST", "/api/ranking/opt-in", form)).json.claim);
    const worker: HttpRequestAuth = {
      kind: "agent",
      agentId: crypto.randomUUID(),
      taskId: null,
      runtimeId: null,
      tokenId: "tok_test",
      expiresAt: "2099-01-01T00:00:00.000Z",
    };
    const guest: HttpRequestAuth = { kind: "guest" };
    for (const auth of [worker, guest]) {
      const denied = await call("GET", "/api/ranking", undefined, handleRanking, auth);
      expect(denied.statusCode).toBe(403);
      expect(JSON.stringify(denied.json)).not.toContain(claim);
    }
    const state = await call("GET", "/api/ranking");
    expect(state.statusCode).toBe(200);
    expect((state.json.listing as { claim: string }).claim).toBe(claim);
  });

  test("concurrent first opt-ins share one claim, and leave then rejoin keeps it", async () => {
    const [first, second] = await Promise.all([
      call("POST", "/api/ranking/opt-in", form),
      call("POST", "/api/ranking/opt-in", form),
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    // Either response may be the one merged into community/ranking.
    const merged = String(first.json.claim);
    expect(second.json.claim).toBe(merged);
    expect(parseTelemetryRanking(String(await configValue("telemetry_ranking")))?.claim).toBe(
      merged,
    );

    expect((await call("POST", "/api/ranking/opt-out")).statusCode).toBe(200);
    const rejoin = await call("POST", "/api/ranking/opt-in", form);
    expect(rejoin.json.claim).toBe(merged);
  });

  test("opt-out stores false, emits ranking.opted_out and returns the delete page", async () => {
    await call("POST", "/api/ranking/opt-in", form);
    sent = [];
    const result = await call("POST", "/api/ranking/opt-out");
    expect(result.statusCode).toBe(200);
    expect(result.json).toEqual({
      enabled: false,
      leaveUrl:
        "https://github.com/desplega-ai/agent-swarm/delete/main/community/ranking/acme.dev.json",
    });
    expect(await configValue("PUBLIC_RANKING_ENABLED")).toBe("false");
    expect(sent.map((event) => [event.event, event.properties.domain])).toEqual([
      ["ranking.opted_out", "acme.dev"],
    ]);
  });

  test("PUT /api/config refuses telemetry_ranking", async () => {
    const result = await call(
      "PUT",
      "/api/config",
      { scope: "global", key: "telemetry_ranking", value: "{}" },
      handleConfig,
    );
    expect(result.statusCode).toBe(400);
    expect(String(result.json.error)).toContain("/api/ranking");
  });

  test("renaming the org re-emits the listing with the same claim", async () => {
    const optIn = await call("POST", "/api/ranking/opt-in", form);
    sent = [];
    const put = await call(
      "PUT",
      "/api/config",
      { scope: "global", key: "SWARM_ORG_NAME", value: "Acme Labs" },
      handleConfig,
    );
    expect(put.statusCode).toBe(200);
    expect(sent.map((event) => event.event)).toEqual(["ranking.opted_in"]);
    const listing = parseTelemetryRanking(String(sent[0]?.properties.listing));
    expect(listing).toMatchObject({
      name: "Acme Labs",
      claim: optIn.json.claim,
      subcategory: "qa-testing",
    });
    // The envelope carries the new name before the config reload reaches process.env.
    expect(sent[0]?.context).toMatchObject({ org_name: "Acme Labs", org_website: "acme.dev" });
    expect(await configValue("PUBLIC_RANKING_ENABLED")).toBe("true");
  });

  test("a placeholder name, a changed website or a name too long for the listing opts out", async () => {
    for (const [key, value] of [
      ["SWARM_ORG_NAME", "Your Swarm"],
      ["SWARM_ORG_NAME", "x".repeat(61)],
      ["SWARM_ORG_WEBSITE", "acme.io"],
    ] as const) {
      await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_NAME", value: "Acme" });
      await upsertSwarmConfig({ scope: "global", key: "SWARM_ORG_WEBSITE", value: "acme.dev" });
      await call("POST", "/api/ranking/opt-in", form);
      sent = [];
      const put = await call("PUT", "/api/config", { scope: "global", key, value }, handleConfig);
      expect(put.statusCode).toBe(200);
      expect(await configValue("PUBLIC_RANKING_ENABLED")).toBe("false");
      expect(sent.map((event) => [event.event, event.properties.domain])).toEqual([
        ["ranking.opted_out", "acme.dev"],
      ]);
    }
    // After the last case (a new website) the old listing needs a new PR.
    const state = await call("GET", "/api/ranking");
    expect(state.json).toMatchObject({ enabled: false, listingMatchesDomain: false, prUrl: null });
  });
});
