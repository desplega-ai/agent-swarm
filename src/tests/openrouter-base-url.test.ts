/**
 * OPENROUTER_BASE_URL gateway routing — unit tests.
 *
 * Covers the shared resolver (`src/utils/openrouter-base-url.ts`), the pi
 * models.json override writer (`ensureOpenRouterModelsOverride`) including
 * its composition through pi-coding-agent's ModelRuntime, and the opencode
 * per-task config injection (`applyOpenRouterBaseUrlOverride`).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { Config } from "@opencode-ai/sdk";
import { applyOpenRouterBaseUrlOverride } from "../providers/opencode-adapter";
import { ensureOpenRouterModelsOverride } from "../providers/pi-mono-adapter";
import { DEFAULT_OPENROUTER_BASE_URL, getOpenRouterBaseUrl } from "../utils/openrouter-base-url";

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

describe("ensureOpenRouterModelsOverride (pi)", () => {
  let agentDir: string;

  beforeAll(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-or-override-"));
  });

  afterAll(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("no-op when OPENROUTER_BASE_URL is unset", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-or-noop-"));
    try {
      await ensureOpenRouterModelsOverride(dir, {});
      expect(await Bun.file(join(dir, "models.json")).exists()).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("writes providers.openrouter.baseUrl when the env is set", async () => {
    await ensureOpenRouterModelsOverride(agentDir, { OPENROUTER_BASE_URL: GATEWAY });
    const written = JSON.parse(await Bun.file(join(agentDir, "models.json")).text());
    expect(written).toEqual({ providers: { openrouter: { baseUrl: GATEWAY } } });
  });

  test("merge-preserves existing providers and openrouter keys", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-or-merge-"));
    try {
      await Bun.write(
        join(dir, "models.json"),
        JSON.stringify({
          providers: {
            openrouter: { baseUrl: "https://old.example/v1", compat: { supportsTools: true } },
            custom: { baseUrl: "https://custom.example/v1", api: "openai-completions" },
          },
        }),
      );
      await ensureOpenRouterModelsOverride(dir, { OPENROUTER_BASE_URL: GATEWAY });
      const written = JSON.parse(await Bun.file(join(dir, "models.json")).text());
      expect(written.providers.openrouter.baseUrl).toBe(GATEWAY);
      expect(written.providers.openrouter.compat).toEqual({ supportsTools: true });
      expect(written.providers.custom).toEqual({
        baseUrl: "https://custom.example/v1",
        api: "openai-completions",
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrites a corrupt models.json with just the override", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-or-corrupt-"));
    try {
      await Bun.write(join(dir, "models.json"), "{not json");
      await ensureOpenRouterModelsOverride(dir, { OPENROUTER_BASE_URL: GATEWAY });
      const written = JSON.parse(await Bun.file(join(dir, "models.json")).text());
      expect(written).toEqual({ providers: { openrouter: { baseUrl: GATEWAY } } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("ModelRuntime composes the override onto built-in OpenRouter models", async () => {
    // The whole point of the lever: built-in model IDs resolved through the
    // runtime's composed store carry the gateway baseUrl.
    const runtime = await ModelRuntime.create({
      authPath: join(agentDir, "auth.json"),
      modelsPath: join(agentDir, "models.json"),
    });
    expect(runtime.getError()).toBeUndefined();
    const model = runtime.getModel("openrouter", "anthropic/claude-sonnet-5");
    expect(model?.baseUrl).toBe(GATEWAY);
  });

  test("ModelRuntime keeps the default baseUrl when no models.json exists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pi-or-default-"));
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(dir, "auth.json"),
        modelsPath: join(dir, "models.json"),
      });
      const model = runtime.getModel("openrouter", "anthropic/claude-sonnet-5");
      expect(model?.baseUrl).toBe(DEFAULT_OPENROUTER_BASE_URL);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("applyOpenRouterBaseUrlOverride (opencode)", () => {
  test("no-op when OPENROUTER_BASE_URL is unset", () => {
    const config: Config = { model: "openrouter/google/gemini-3-flash-preview" };
    applyOpenRouterBaseUrlOverride(config, {});
    expect(config.provider).toBeUndefined();
  });

  test("sets provider.openrouter.options.baseURL when the env is set", () => {
    const config: Config = { model: "openrouter/google/gemini-3-flash-preview" };
    applyOpenRouterBaseUrlOverride(config, { OPENROUTER_BASE_URL: GATEWAY });
    expect(config.provider?.openrouter?.options?.baseURL).toBe(GATEWAY);
  });

  test("preserves existing provider config (e.g. reasoning model options)", () => {
    const config: Config = {
      model: "openrouter/google/gemini-3-flash-preview",
      provider: {
        openrouter: {
          models: {
            "google/gemini-3-flash-preview": { options: { reasoning: { effort: "low" } } },
          },
          options: { apiKey: "sk-keep" },
        },
        anthropic: { options: { apiKey: "sk-ant" } },
      },
    };
    applyOpenRouterBaseUrlOverride(config, { OPENROUTER_BASE_URL: GATEWAY });
    expect(config.provider?.openrouter?.options).toEqual({
      apiKey: "sk-keep",
      baseURL: GATEWAY,
    });
    expect(config.provider?.openrouter?.models).toEqual({
      "google/gemini-3-flash-preview": { options: { reasoning: { effort: "low" } } },
    });
    expect(config.provider?.anthropic).toEqual({ options: { apiKey: "sk-ant" } });
  });
});
