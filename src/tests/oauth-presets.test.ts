import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { unlink } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { closeDb, createAgent, initDb } from "../be/db";
import { getOAuthApp } from "../be/db-queries/oauth";
import { handleScriptConnections } from "../http/script-connections";
import { getPathSegments, parseQueryParams } from "../http/utils";
import { assertOAuthAppUrlsSafe } from "../oauth/app-validation";
import {
  getOAuthPreset,
  hydrateOAuthAppFromPreset,
  listOAuthPresetIds,
  listOAuthPresets,
} from "../oauth/presets";
import { buildAuthorizationUrl } from "../oauth/wrapper";

const TEST_DB_PATH = "./test-oauth-presets.sqlite";

async function removeDbFiles(path: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      await unlink(path + suffix);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
}

type TestResponse = { status: number; text: string; json: () => Promise<unknown> };

async function dispatch(
  path: string,
  init: { method?: string; body?: unknown; agentId?: string } = {},
): Promise<TestResponse> {
  const req = Readable.from(
    init.body === undefined ? [] : [Buffer.from(JSON.stringify(init.body))],
  ) as IncomingMessage;
  req.method = init.method ?? "GET";
  req.url = path;
  req.headers = init.agentId
    ? { "x-agent-id": init.agentId, "content-type": "application/json" }
    : { "content-type": "application/json" };

  let status = 200;
  let text = "";
  const res = {
    headersSent: false,
    writableEnded: false,
    setHeader() {},
    writeHead(code: number) {
      status = code;
      this.headersSent = true;
      return this;
    },
    end(chunk?: unknown) {
      if (chunk !== undefined) text += String(chunk);
      this.writableEnded = true;
      return this;
    },
  } as unknown as ServerResponse;

  const pathSegments = getPathSegments(req.url || "");
  const queryParams = parseQueryParams(req.url || "");
  if (!(await handleScriptConnections(req, res, pathSegments, queryParams, init.agentId))) {
    res.writeHead(404);
    res.end("Not Found");
  }
  return { status, text, json: async () => JSON.parse(text) };
}

let leadAgentId: string;

beforeAll(async () => {
  await removeDbFiles(TEST_DB_PATH);
  initDb(TEST_DB_PATH);
  leadAgentId = createAgent({ name: "presets-lead", isLead: true, status: "idle" }).id;
});

afterAll(async () => {
  closeDb();
  await removeDbFiles(TEST_DB_PATH);
});

describe("oauth presets — pure data", () => {
  test("exposes the expected curated preset ids", () => {
    expect(listOAuthPresetIds().sort()).toEqual(
      ["github", "google", "jira", "linear", "notion", "slack"].sort(),
    );
    expect(listOAuthPresets()).toHaveLength(6);
  });

  test("every preset carries endpoints, setup hints, and SSRF-safe URLs", () => {
    for (const preset of listOAuthPresets()) {
      expect(preset.authorizeUrl.startsWith("https://")).toBe(true);
      expect(preset.tokenUrl.startsWith("https://")).toBe(true);
      // Parse without throwing.
      expect(() => new URL(preset.authorizeUrl)).not.toThrow();
      expect(() => new URL(preset.tokenUrl)).not.toThrow();
      if (preset.revocationUrl) expect(() => new URL(preset.revocationUrl as string)).not.toThrow();
      if (preset.userinfoUrl) expect(() => new URL(preset.userinfoUrl as string)).not.toThrow();
      expect(preset.setupHints.length).toBeGreaterThan(0);
      // Defense in depth: the merged endpoints must survive the SSRF gate.
      expect(() =>
        assertOAuthAppUrlsSafe({ authorizeUrl: preset.authorizeUrl, tokenUrl: preset.tokenUrl }),
      ).not.toThrow();
    }
  });

  test("provider-specific quirks are encoded", () => {
    const google = getOAuthPreset("google");
    expect(google?.extraParams).toMatchObject({ access_type: "offline", prompt: "consent" });
    expect(google?.scopeSeparator).toBe(" ");

    const notion = getOAuthPreset("notion");
    expect(notion?.tokenAuthStyle).toBe("basic");
    expect(notion?.tokenBodyFormat).toBe("json");

    const jira = getOAuthPreset("jira");
    expect(jira?.requiresRefreshTokenRotation).toBe(true);

    const linear = getOAuthPreset("linear");
    expect(linear?.scopeSeparator).toBe(",");

    const slack = getOAuthPreset("slack");
    expect(slack?.scopeSeparator).toBe(",");
  });

  test("hydration marks curated-prefill and lets explicit fields win", () => {
    const preset = getOAuthPreset("google");
    if (!preset) throw new Error("google preset missing");

    const merged = hydrateOAuthAppFromPreset(preset, {
      tokenUrl: "https://custom.example.com/token",
      scopes: ["custom.scope"],
      extraParams: { prompt: "select_account" },
    });

    expect(merged.source).toBe("curated-prefill");
    expect(merged.authorizeUrl).toBe(preset.authorizeUrl); // filled from preset
    expect(merged.tokenUrl).toBe("https://custom.example.com/token"); // explicit wins
    expect(merged.scopes).toEqual(["custom.scope"]); // explicit wins
    // extraParams merge per-key: explicit prompt wins, preset access_type stays.
    expect(merged.extraParams).toMatchObject({ access_type: "offline", prompt: "select_account" });
    expect(merged.setupHints).toEqual(preset.setupHints);
  });

  test("google hydration yields offline params in the built authorization URL", async () => {
    const preset = getOAuthPreset("google");
    if (!preset) throw new Error("google preset missing");
    const hydrated = hydrateOAuthAppFromPreset(preset, {});

    // buildAuthorizationUrl now persists a PKCE pending row keyed to a real app
    // (step-4), so the app must exist first.
    const created = await dispatch("/api/oauth-apps", {
      method: "POST",
      agentId: leadAgentId,
      body: { presetId: "google", clientId: "google-client", clientSecret: "google-secret" },
    });
    expect(created.status).toBe(200);

    const { url } = await buildAuthorizationUrl(
      {
        provider: hydrated.provider,
        clientId: "google-client",
        clientSecret: "google-secret",
        authorizeUrl: hydrated.authorizeUrl,
        tokenUrl: hydrated.tokenUrl,
        redirectUri: "https://api.public.test/api/oauth/callback",
        scopes: hydrated.scopes,
        scopeSeparator: hydrated.scopeSeparator,
        extraParams: hydrated.extraParams,
      },
      { flow: "generic" },
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("access_type")).toBe("offline");
    expect(parsed.searchParams.get("prompt")).toBe("consent");
    // Space separator surfaces as `+` / `%20` in the encoded scope.
    expect(parsed.searchParams.get("scope")).toBe("openid email profile");
  });
});

describe("oauth presets — HTTP", () => {
  test("GET /api/oauth-presets lists all six presets with hints", async () => {
    const res = await dispatch("/api/oauth-presets");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      presets: Array<{ id: string; authorizeUrl: string; setupHints: string[] }>;
    };
    expect(body.presets).toHaveLength(6);
    expect(body.presets.map((p) => p.id).sort()).toEqual(
      ["github", "google", "jira", "linear", "notion", "slack"].sort(),
    );
    for (const preset of body.presets) {
      expect(preset.authorizeUrl.startsWith("https://")).toBe(true);
      expect(preset.setupHints.length).toBeGreaterThan(0);
    }
    // No secrets ever live in presets.
    expect(res.text).not.toContain("clientSecret");
  });

  test("POST /api/oauth-apps with presetId 'google' hydrates endpoints + source", async () => {
    const res = await dispatch("/api/oauth-apps", {
      method: "POST",
      agentId: leadAgentId,
      body: { presetId: "google", clientId: "google-client", clientSecret: "google-secret" },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      oauthApp: { provider: string; authorizeUrl: string; source: string };
      redirectUri: string;
      setupHints: string[];
    };
    expect(body.redirectUri).toContain("/api/oauth/callback");
    expect(body.setupHints.length).toBeGreaterThan(0);
    expect(body.oauthApp.source).toBe("curated-prefill");
    expect(res.text).not.toContain("google-secret");

    const stored = getOAuthApp("google");
    expect(stored?.source).toBe("curated-prefill");
    expect(stored?.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(stored?.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(stored?.scopeSeparator).toBe(" ");
    expect(stored?.revocationUrl).toBe("https://oauth2.googleapis.com/revoke");
    expect(stored?.extraParamsJson ?? "").toContain("access_type");
    expect(stored?.clientSecret).toBe("google-secret");
  });

  test("explicit fields override the preset during hydration", async () => {
    const res = await dispatch("/api/oauth-apps", {
      method: "POST",
      agentId: leadAgentId,
      body: {
        presetId: "google",
        provider: "google_custom",
        clientId: "gc",
        clientSecret: "gcs",
        tokenUrl: "https://custom.example.com/token",
      },
    });
    expect(res.status).toBe(200);
    const stored = getOAuthApp("google_custom");
    expect(stored?.tokenUrl).toBe("https://custom.example.com/token");
    expect(stored?.authorizeUrl).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(stored?.source).toBe("curated-prefill");
  });

  test("unknown presetId is rejected with 400 listing valid ids", async () => {
    const res = await dispatch("/api/oauth-apps", {
      method: "POST",
      agentId: leadAgentId,
      body: { presetId: "not-a-real-preset", clientId: "c", clientSecret: "s" },
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toContain("Unknown presetId");
    expect(body.error).toContain("google");
  });
});
