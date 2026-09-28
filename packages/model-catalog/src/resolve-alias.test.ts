import { describe, expect, test } from "bun:test";
import { isAlias, mergeCatalog, parseAlias, resolveAlias } from "./index.ts";
import type { ModelsDevCatalog } from "./types.ts";

const catalog: ModelsDevCatalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-8": { release_date: "2026-05-01" },
      "claude-opus-5": { release_date: "2026-09-20" },
      "claude-opus-5-20260920": { release_date: "2026-09-20" },
      "claude-haiku-4-5": { release_date: "2025-10-01" },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "deepseek/deepseek-v4-flash": { release_date: "2026-04-01" },
      "deepseek/deepseek-v4.1-flash": { release_date: "2026-08-01" },
      "deepseek/deepseek-v4.2-flash-preview": { release_date: "2026-09-01" },
      "deepseek/deepseek-v4.1-flash:free": { release_date: "2026-09-02" },
    },
  },
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-5-sol": { release_date: "2026-03-01" },
      "gpt-6-sol": { release_date: "2026-07-01" },
      "gpt-6-sol-20260701": { release_date: "2026-07-01" },
      "gpt-7-sol": { release_date: "2026-09-25" },
      "gpt-7-sol-preview": { release_date: "2026-09-26" },
      "gpt-8-experimental-sol": { release_date: "2026-01-01" },
      "gpt-6-sol-latest": { release_date: "2026-09-27" },
    },
  },
};

const now = new Date("2026-09-28T00:00:00Z");

describe("isAlias / parseAlias", () => {
  test("isAlias", () => {
    expect(isAlias("latest:openai/gpt-*")).toBe(true);
    expect(isAlias(" LATEST:anthropic/opus")).toBe(true);
    expect(isAlias("gpt-5")).toBe(false);
  });
  test("channel suffix", () => {
    expect(parseAlias("latest:openai/gpt-*-sol")).toEqual({
      kind: "openai",
      glob: "gpt-*-sol",
      channel: "stable",
    });
    expect(parseAlias("latest:anthropic/opus@any")?.channel).toBe("any");
    expect(parseAlias("latest:anthropic/opus@stable")?.channel).toBe("stable");
    expect(parseAlias("latest:anthropic/opus@beta")).toBeNull();
    expect(parseAlias("latest:google/gemini")).toBeNull();
  });
});

describe("legacy aliases resolve as before", () => {
  test("anthropic", () => {
    expect(resolveAlias("latest:anthropic/opus", catalog)).toBe("claude-opus-5");
    expect(resolveAlias("latest:anthropic/haiku", catalog)).toBe("claude-haiku-4-5");
    expect(resolveAlias("latest:anthropic/fable", catalog)).toBeNull();
  });
  test("openrouter", () => {
    expect(resolveAlias("latest:openrouter/deepseek/deepseek-v4*-flash", catalog)).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash",
    );
    expect(resolveAlias("latest:openrouter/deepseek/deepseek-v4*-flash*", catalog)).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash",
    );
    expect(resolveAlias("latest:openrouter/deepseek/*-preview", catalog)).toBe(
      "openrouter/deepseek/deepseek-v4.2-flash-preview",
    );
  });
});

describe("openai section", () => {
  test("newest undated non-preview id, no prefix", () => {
    expect(resolveAlias("latest:openai/gpt-*-sol", catalog)).toBe("gpt-7-sol");
    expect(resolveAlias("latest:openai/gpt-*", catalog)).toBe("gpt-7-sol");
  });
  test("@stable drops experimental unless named", () => {
    expect(resolveAlias("latest:openai/gpt-8*", catalog)).toBeNull();
    expect(resolveAlias("latest:openai/gpt-8-experimental*", catalog)).toBe(
      "gpt-8-experimental-sol",
    );
  });
});

describe("policy", () => {
  test("@stable soak excludes young models", () => {
    expect(resolveAlias("latest:openai/gpt-*-sol", catalog, { soakDays: 7, now })).toBe(
      "gpt-6-sol",
    );
    expect(resolveAlias("latest:anthropic/opus", catalog, { soakDays: 14, now })).toBe(
      "claude-opus-4-8",
    );
    expect(resolveAlias("latest:openai/gpt-*-sol@stable", catalog, { soakDays: 2, now })).toBe(
      "gpt-7-sol",
    );
  });
  test("@any disables preview and soak filters", () => {
    expect(resolveAlias("latest:openai/gpt-7*@any", catalog, { soakDays: 30, now })).toBe(
      "gpt-7-sol-preview",
    );
    expect(resolveAlias("latest:anthropic/opus@any", catalog, { soakDays: 30, now })).toBe(
      "claude-opus-5",
    );
    expect(resolveAlias("latest:openai/gpt-8*@any", catalog)).toBe("gpt-8-experimental-sol");
  });
  test("isSupported filters candidates on every channel", () => {
    const isSupported = (id: string) => id !== "gpt-7-sol" && id !== "claude-opus-5";
    expect(resolveAlias("latest:openai/gpt-*-sol", catalog, { isSupported })).toBe("gpt-6-sol");
    expect(resolveAlias("latest:anthropic/opus@any", catalog, { isSupported })).toBe(
      "claude-opus-4-8",
    );
    expect(resolveAlias("latest:openai/*", catalog, { isSupported: () => false })).toBeNull();
  });
});

describe("mergeCatalog", () => {
  test("overlay wins field-by-field, keeps both sides, no mutation", () => {
    const base: ModelsDevCatalog = {
      openai: {
        id: "openai",
        name: "OpenAI",
        models: { "gpt-5": { name: "GPT-5", release_date: "2026-01-01", reasoning: true } },
      },
      anthropic: { id: "anthropic", name: "Anthropic", models: { "claude-x": {} } },
    };
    const merged = mergeCatalog(base, {
      openai: {
        models: { "gpt-5": { release_date: "2026-02-02" }, "gpt-6": { name: "GPT-6" } },
      },
      xai: { name: "xAI", models: { grok: { name: "Grok" } } },
    });
    expect(merged.openai?.models["gpt-5"]).toEqual({
      name: "GPT-5",
      release_date: "2026-02-02",
      reasoning: true,
    });
    expect(merged.openai?.models["gpt-6"]).toEqual({ name: "GPT-6" });
    expect(merged.openai?.name).toBe("OpenAI");
    expect(merged.anthropic?.models["claude-x"]).toEqual({});
    expect(merged.xai).toEqual({ id: "xai", name: "xAI", models: { grok: { name: "Grok" } } });
    expect(base.openai?.models["gpt-5"]?.release_date).toBe("2026-01-01");
    expect(base.openai?.models["gpt-6"]).toBeUndefined();
  });
});
