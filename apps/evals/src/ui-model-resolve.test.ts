import { describe, expect, test } from "bun:test";
import { configs } from "../configs/index.ts";
import { buildModelResolver, modelIdCandidates } from "../ui/src/lib/model-resolve.ts";
import type { ModelJson } from "../ui/src/types.ts";
import { getClaudeAliasMap, listHarnessModels, listOpenrouterModels } from "./cost/pricing.ts";

function model(id: string, name = id): ModelJson {
  return {
    id,
    name,
    reasoning: false,
    toolCall: true,
    context: null,
    inputPerM: 1,
    outputPerM: 2,
    cacheReadPerM: null,
    cacheWritePerM: null,
  };
}

describe("modelIdCandidates", () => {
  test("expands prefix, date suffix and dotted versions in order", () => {
    expect(modelIdCandidates("openrouter/anthropic/claude-haiku-4-5-20251001")).toEqual([
      "openrouter/anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-haiku-4-5-20251001",
      "anthropic/claude-haiku-4-5",
      "anthropic/claude-haiku-4.5",
    ]);
  });
});

describe("buildModelResolver", () => {
  const openrouter = [model("deepseek/deepseek-v4-flash", "DeepSeek V4 Flash")];
  const harness = [
    model("claude-sonnet-5-5", "Claude Sonnet 5.5"),
    model("claude-haiku-4-5", "Claude Haiku 4.5"),
    model("gpt-5.6-sol", "GPT-5.6 Sol"),
  ];
  const aliases = { haiku: "claude-haiku-4-5" };

  test("finds claude and codex ids through the harness entries", () => {
    const resolve = buildModelResolver({ models: openrouter, harnessModels: harness, aliases });
    expect(resolve("claude-sonnet-5-5")?.name).toBe("Claude Sonnet 5.5");
    expect(resolve("gpt-5.6-sol")?.name).toBe("GPT-5.6 Sol");
    // dated snapshot id strips to the canonical entry
    expect(resolve("claude-haiku-4-5-20251001")?.id).toBe("claude-haiku-4-5");
  });

  test("bare aliases map first; openrouter prefix and suffix matches still work", () => {
    const resolve = buildModelResolver({ models: openrouter, harnessModels: harness, aliases });
    expect(resolve("Haiku ")?.id).toBe("claude-haiku-4-5");
    expect(resolve("openrouter/deepseek/deepseek-v4-flash")?.id).toBe("deepseek/deepseek-v4-flash");
    expect(resolve("deepseek-v4-flash")?.id).toBe("deepseek/deepseek-v4-flash");
  });

  test("unknown ids, null and empty stay unresolved; old servers without harness entries degrade", () => {
    const resolve = buildModelResolver({ models: openrouter, harnessModels: harness, aliases });
    expect(resolve("no-such-model")).toBeNull();
    expect(resolve(null)).toBeNull();
    expect(resolve("")).toBeNull();
    const legacy = buildModelResolver({ models: openrouter });
    expect(legacy("claude-sonnet-5-5")).toBeNull();
    expect(legacy("deepseek/deepseek-v4-flash")?.name).toBe("DeepSeek V4 Flash");
    expect(buildModelResolver({ models: [] })("claude-sonnet-5-5")).toBeNull();
  });
});

describe("seeded configs against the real /api/models sources", () => {
  test("every pinned config model resolves to a name + price card", async () => {
    const resolve = buildModelResolver({
      models: await listOpenrouterModels(),
      harnessModels: await listHarnessModels(),
      aliases: await getClaudeAliasMap(),
    });
    const misses = configs
      .filter((c) => c.model !== undefined && resolve(c.model) === null)
      .map((c) => `${c.id} (${c.model})`);
    expect(misses).toEqual([]);
  });
});
