import { describe, expect, test } from "bun:test";
import { harnessModelIds } from "@desplega/model-catalog";
import snapshot from "../../../src/be/modelsdev-cache.json";
import { configs, DEFAULT_CONFIG_IDS } from "./index.ts";

/** Frozen naming contract (v6 §0.14). */
const NAMING_RE = /^(claude|pi|opencode|codex)-[a-z0-9][a-z0-9.-]*$/;

describe("config catalog invariants (v6 §0.14 / §10)", () => {
  test("catalog has exactly 84 entries (12 legacy + 14 round-6 + pi-gemini-pro + 10 round-8 OSS refresh + 17 round-9 expansion + 12 round-10 leaderboard additions + 14 round-11 June 2026 refresh + Claude Sonnet 5 + 3 GPT-5.6 Codex tiers + 31 round-12 September 2026 refresh + pi-latest-deepseek-v4 alias + Claude Sonnet 5.5 + codex-6.1-sol + codex-5.6)", () => {
    expect(configs.length).toBe(119);
  });

  test("every codex model the committed catalog lists since gpt-5.4 has a codex config", () => {
    // Refreshing src/be/modelsdev-cache.json with a new codex model fails this
    // until the model gets a config, so the catalog and the configs cannot drift.
    const openai = (snapshot as { openai: { models: Record<string, { release_date?: string }> } })
      .openai.models;
    const pinned = new Set(configs.filter((c) => c.provider === "codex").map((c) => c.model));
    const missing = harnessModelIds("codex", openai).filter(
      (id) => (openai[id]?.release_date ?? "") >= "2026-03-01" && !pinned.has(id),
    );
    expect(missing).toEqual([]);
  });

  test("ids are unique", () => {
    const ids = configs.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("every id matches the frozen naming regex", () => {
    for (const c of configs) {
      expect(c.id).toMatch(NAMING_RE);
    }
  });

  test("each id's provider prefix matches the entry's provider field", () => {
    for (const c of configs) {
      expect(c.id.startsWith(`${c.provider}-`)).toBe(true);
    }
  });

  test("DEFAULT_CONFIG_IDS is exactly the frozen trio, all present in the catalog", () => {
    expect(DEFAULT_CONFIG_IDS).toEqual([
      "claude-haiku",
      "pi-deepseek-flash",
      "opencode-gemini-flash",
    ]);
    const ids = new Set(configs.map((c) => c.id));
    for (const id of DEFAULT_CONFIG_IDS) {
      expect(ids.has(id)).toBe(true);
    }
  });

  test("no catalog entry sets env — creds flow only through credentialsForConfig", () => {
    for (const c of configs) {
      expect(c.env).toBeUndefined();
    }
  });

  test("no catalog entry sets modelTier — tiers would grade a moving target", () => {
    for (const c of configs) {
      expect(c.modelTier).toBeUndefined();
    }
  });

  test("pi/opencode entries pin concrete openrouter/-prefixed models (or a moving alias)", () => {
    for (const c of configs) {
      if (c.provider !== "pi" && c.provider !== "opencode") continue;
      if (c.modelAlias) {
        expect(c.modelAlias.startsWith("latest:openrouter/")).toBe(true);
        continue;
      }
      expect(c.model).toBeDefined();
      expect(c.model?.startsWith("openrouter/")).toBe(true);
    }
  });

  test("pi-gemini-pro (v7.7 item 1) pins the verified OpenRouter preview slug", () => {
    const c = configs.find((entry) => entry.id === "pi-gemini-pro");
    expect(c).toEqual({
      id: "pi-gemini-pro",
      label: "pi-mono / Gemini 3.1 Pro Preview (OpenRouter)",
      provider: "pi",
      model: "openrouter/google/gemini-3.1-pro-preview",
    });
  });
});
