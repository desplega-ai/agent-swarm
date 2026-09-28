import { describe, expect, test } from "bun:test";
import { configs } from "../../configs/index.ts";
import type { ModelsDevCatalog } from "./catalog.ts";
import { getResolutionCatalog, getSnapshotCatalog } from "./catalog.ts";
import {
  legacyAliasModel,
  parseAlias,
  resolveAlias,
  validateConfigModel,
} from "./resolve-alias.ts";

const CATALOG: ModelsDevCatalog = {
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-opus-4-8": { release_date: "2026-03-01" },
      "claude-opus-5-5": { release_date: "2026-09-01" },
      "claude-opus-5-5-20260901": { release_date: "2026-09-02" },
      "claude-opus-latest": { release_date: "2026-09-03" },
      "claude-sonnet-5": { release_date: "2026-07-01" },
    },
  },
  openrouter: {
    id: "openrouter",
    name: "OpenRouter",
    models: {
      "deepseek/deepseek-v4-flash": { release_date: "2026-04-01" },
      "deepseek/deepseek-v4.1-flash": { release_date: "2026-08-01" },
      "deepseek/deepseek-v4.2-flash:free": { release_date: "2026-09-10" },
      "deepseek/deepseek-v4.2-flash-preview": { release_date: "2026-09-11" },
      "deepseek/deepseek-v4-pro": { release_date: "2026-09-12" },
    },
  },
};

describe("resolveAlias", () => {
  test("latest:anthropic/<family> picks the newest undated family member", () => {
    expect(resolveAlias("latest:anthropic/opus", CATALOG)).toBe("claude-opus-5-5");
    expect(resolveAlias("latest:anthropic/sonnet", CATALOG)).toBe("claude-sonnet-5");
    expect(resolveAlias("latest:anthropic/fable", CATALOG)).toBeNull();
  });

  test("latest:openrouter/<glob> skips free, preview, dated and -latest ids", () => {
    expect(resolveAlias("latest:openrouter/deepseek/deepseek-v4*-flash", CATALOG)).toBe(
      "openrouter/deepseek/deepseek-v4.1-flash",
    );
    expect(resolveAlias("latest:openrouter/deepseek/deepseek-v4*", CATALOG)).toBe(
      "openrouter/deepseek/deepseek-v4-pro",
    );
  });

  test("a glob that names :free or preview opts in", () => {
    expect(resolveAlias("latest:openrouter/deepseek/*:free", CATALOG)).toBe(
      "openrouter/deepseek/deepseek-v4.2-flash:free",
    );
    expect(resolveAlias("latest:openrouter/deepseek/*-preview", CATALOG)).toBe(
      "openrouter/deepseek/deepseek-v4.2-flash-preview",
    );
  });

  test("invalid grammar never resolves", () => {
    for (const bad of [
      "opus",
      "latest:",
      "latest:openai/gpt*",
      "latest:anthropic/opus-5",
      "x:anthropic/opus",
    ]) {
      expect(parseAlias(bad)).toBeNull();
      expect(resolveAlias(bad, CATALOG)).toBeNull();
    }
  });

  test("legacyAliasModel maps anthropic aliases to the bare family", () => {
    expect(legacyAliasModel("latest:anthropic/opus")).toBe("opus");
    expect(legacyAliasModel("latest:openrouter/deepseek/*")).toBeNull();
  });
});

describe("validateConfigModel", () => {
  test("model and modelAlias are mutually exclusive", () => {
    expect(
      validateConfigModel({
        id: "claude-x",
        provider: "claude",
        model: "opus",
        modelAlias: "latest:anthropic/opus",
      }),
    ).toEqual(["sets both model and modelAlias; pick one"]);
  });

  test("alias section must match the provider", () => {
    expect(
      validateConfigModel({
        id: "codex-x",
        provider: "codex",
        modelAlias: "latest:anthropic/opus",
      }),
    ).toHaveLength(1);
    expect(
      validateConfigModel({
        id: "claude-x",
        provider: "claude",
        modelAlias: "latest:openrouter/a/*",
      }),
    ).toHaveLength(1);
  });

  test("every catalog config is valid", () => {
    for (const config of configs) expect(validateConfigModel(config)).toEqual([]);
  });
});

describe("alias configs against the reviewed catalog", () => {
  test("every alias config resolves to an ID present in the committed snapshot", async () => {
    const snapshot = await getSnapshotCatalog();
    const catalog = await getResolutionCatalog();
    const aliased = configs.filter((c) => c.modelAlias);
    expect(aliased.map((c) => c.id).sort()).toEqual([
      "claude-haiku",
      "claude-opus",
      "claude-sonnet",
      "pi-latest-deepseek-v4",
    ]);
    for (const config of aliased) {
      const resolved = resolveAlias(config.modelAlias ?? "", catalog);
      expect(resolved).not.toBeNull();
      const section = config.provider === "claude" ? "anthropic" : "openrouter";
      const id = resolved?.replace(/^openrouter\//, "") ?? "";
      expect(Object.keys(snapshot[section]?.models ?? {})).toContain(id);
    }
  });
});
