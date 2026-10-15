/**
 * OPENROUTER_BASE_URL gateway routing — unit tests.
 *
 * Covers the shared resolver (`src/utils/openrouter-base-url.ts`), the pi
 * per-session models.json composer (`writeSessionModelsJson`) for every shared
 * starting state, its composition through pi-coding-agent's ModelRuntime, and
 * attribution host gating.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { writeSessionModelsJson } from "../providers/pi-mono-adapter";
import {
  DEFAULT_OPENROUTER_BASE_URL,
  getOpenRouterAttributionHeaders,
  getOpenRouterBaseUrl,
} from "../utils/openrouter-base-url";

const GATEWAY = "https://control-plane.example/proxy/v1";

describe("getOpenRouterBaseUrl", () => {
  test("defaults to openrouter.ai when unset", () => {
    expect(getOpenRouterBaseUrl({} as NodeJS.ProcessEnv)).toBe(DEFAULT_OPENROUTER_BASE_URL);
  });

  test("blank / whitespace-only values fall back to the default", () => {
    expect(getOpenRouterBaseUrl({ OPENROUTER_BASE_URL: "" } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_OPENROUTER_BASE_URL,
    );
    expect(getOpenRouterBaseUrl({ OPENROUTER_BASE_URL: "   " } as NodeJS.ProcessEnv)).toBe(
      DEFAULT_OPENROUTER_BASE_URL,
    );
  });

  test("returns the override verbatim (trimmed)", () => {
    expect(getOpenRouterBaseUrl({ OPENROUTER_BASE_URL: ` ${GATEWAY} ` } as NodeJS.ProcessEnv)).toBe(
      GATEWAY,
    );
  });

  test("strips trailing slashes so call sites can append paths", () => {
    expect(getOpenRouterBaseUrl({ OPENROUTER_BASE_URL: `${GATEWAY}//` } as NodeJS.ProcessEnv)).toBe(
      GATEWAY,
    );
  });
});

describe("writeSessionModelsJson — OpenRouter gateway (pi)", () => {
  const MARKER = ".agent-swarm-openrouter-override.json";
  const LEGACY = "https://legacy-gateway.example/v1";
  const USER = "https://user.example/v1";
  const userOpenRouter = { baseUrl: USER, compat: { supportsTools: true } };
  const custom = { baseUrl: "https://custom.example/v1", api: "openai-completions" };

  /** Starting states of the shared agent dir; the marker ones are left by earlier versions. */
  const states: Record<string, Record<string, string>> = {
    "no models.json": {},
    "hand-authored baseUrl": {
      "models.json": JSON.stringify({ providers: { openrouter: userOpenRouter, custom } }),
    },
    "legacy override over a user baseUrl": {
      "models.json": JSON.stringify({
        providers: { openrouter: { ...userOpenRouter, baseUrl: LEGACY }, custom },
      }),
      [MARKER]: JSON.stringify({ baseUrl: LEGACY, previous: USER }),
    },
    "legacy override alone": {
      "models.json": JSON.stringify({ providers: { openrouter: { baseUrl: LEGACY } } }),
      [MARKER]: JSON.stringify({ baseUrl: LEGACY }),
    },
    "legacy marker, baseUrl edited by hand since": {
      "models.json": JSON.stringify({ providers: { openrouter: { baseUrl: USER } } }),
      [MARKER]: JSON.stringify({ baseUrl: LEGACY }),
    },
    "corrupt models.json": { "models.json": "{not json" },
  };

  // The openrouter block the session's runtime loads, per state, for the
  // default gateway and for OPENROUTER_BASE_URL=GATEWAY. `null`: no copy, and
  // the session loads the shared file as it is.
  const expected: Record<string, [defaultGateway: unknown, gateway: unknown]> = {
    "no models.json": [null, { baseUrl: GATEWAY }],
    "hand-authored baseUrl": [null, { ...userOpenRouter, baseUrl: GATEWAY }],
    "legacy override over a user baseUrl": [
      userOpenRouter,
      { ...userOpenRouter, baseUrl: GATEWAY },
    ],
    "legacy override alone": [undefined, { baseUrl: GATEWAY }],
    "legacy marker, baseUrl edited by hand since": [{ baseUrl: USER }, { baseUrl: GATEWAY }],
    "corrupt models.json": [null, { baseUrl: GATEWAY }],
  };

  function snapshot(dir: string): Record<string, string> {
    return Object.fromEntries(
      readdirSync(dir)
        .sort()
        .map((name) => [name, readFileSync(join(dir, name), "utf-8")]),
    );
  }

  for (const [state, files] of Object.entries(states)) {
    for (const [i, env] of [{}, { OPENROUTER_BASE_URL: GATEWAY }].entries()) {
      const label = i === 0 ? "default gateway" : "session gateway";
      test(`${state}, ${label}: composed privately, shared dir untouched`, async () => {
        const dir = mkdtempSync(join(tmpdir(), "pi-or-session-"));
        try {
          for (const [name, text] of Object.entries(files)) await Bun.write(join(dir, name), text);
          const before = snapshot(dir);
          const session = await writeSessionModelsJson(dir, env);
          try {
            const want = expected[state]?.[i];
            if (want === null) {
              expect(session.modelsPath).toBeUndefined();
            } else {
              expect(session.modelsPath).toBeDefined();
              expect(session.modelsPath?.startsWith(dir)).toBe(false);
              const copy = JSON.parse(readFileSync(session.modelsPath as string, "utf-8"));
              expect(copy.providers?.openrouter).toEqual(want);
              if (files["models.json"]?.includes("custom.example")) {
                expect(copy.providers.custom).toEqual(custom);
              }
            }
          } finally {
            await session.dispose();
          }
          expect(snapshot(dir)).toEqual(before);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      });
    }
  }

  test("ModelRuntime composes the override onto built-in OpenRouter models", async () => {
    // The whole point of the lever: built-in model IDs resolved through the
    // runtime's composed store carry the gateway baseUrl.
    const dir = mkdtempSync(join(tmpdir(), "pi-or-runtime-"));
    const session = await writeSessionModelsJson(dir, { OPENROUTER_BASE_URL: GATEWAY });
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: session.modelsPath,
      });
      expect(runtime.getError()).toBeUndefined();
      const model = runtime.getModel("openrouter", "anthropic/claude-sonnet-5");
      expect(model?.baseUrl).toBe(GATEWAY);
    } finally {
      await session.dispose();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ModelRuntime keeps the default baseUrl when no models.json exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-or-default-"));
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
      });
      const model = runtime.getModel("openrouter", "anthropic/claude-sonnet-5");
      // pi-ai 0.85.1 stores the Anthropic-flavored OpenRouter root without /v1:
      // dist/api/anthropic-messages.js:730-734 passes it to the Anthropic SDK,
      // whose resources/messages/messages.mjs:31 appends /v1/messages.
      expect(model?.baseUrl).toBe("https://openrouter.ai/api");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("getOpenRouterAttributionHeaders", () => {
  test.each([
    "https://openrouter.ai/api/v1",
    "https://api.openrouter.ai/v1",
  ])("attributes direct OpenRouter host %s", (url) => {
    expect(getOpenRouterAttributionHeaders(url, {})).toEqual({
      "HTTP-Referer": "https://agent-swarm.dev",
      "X-OpenRouter-Title": "Agent Swarm",
      "X-OpenRouter-Categories": "personal-agent,cloud-agent",
    });
  });
  test.each([
    "http://localhost:1234/v1",
    "https://evil-openrouter.ai",
    "https://openrouter.ai.evil.com",
    "invalid",
  ])("does not attribute gateway, lookalike or invalid URL %s", (url) => {
    expect(getOpenRouterAttributionHeaders(url, {})).toEqual({});
  });
  test.each(["false", "FALSE", "FaLsE", "0"])("honors opt-out %s", (value) => {
    expect(
      getOpenRouterAttributionHeaders("https://openrouter.ai", {
        OPENROUTER_APP_ATTRIBUTION: value,
      }),
    ).toEqual({});
  });
});
