import { afterEach, describe, expect, test } from "bun:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import {
  DEFAULT_MODEL,
  MEMORY_RATER_DEFAULT_MODEL,
  parseModelStr,
  resolveRaterModelString,
} from "../../utils/internal-ai/models.js";

describe("internal-ai default models", () => {
  for (const [kind, modelString] of Object.entries(DEFAULT_MODEL)) {
    if (kind === "claude-cli") continue;

    test(`${kind} resolves in the pinned pi-ai catalog`, () => {
      const [provider, modelId] = parseModelStr(modelString);
      const model = getBuiltinModel(
        provider as Parameters<typeof getBuiltinModel>[0],
        modelId as never,
      );
      expect(model).toBeDefined();
      expect(model.id).toBe(modelId);
      expect(model.provider).toBe(provider);
    });
  }
});

describe("memory rater default models", () => {
  const savedEnv = process.env.MEMORY_RATER_MODEL;
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.MEMORY_RATER_MODEL;
    else process.env.MEMORY_RATER_MODEL = savedEnv;
  });

  for (const [kind, modelString] of Object.entries(MEMORY_RATER_DEFAULT_MODEL)) {
    if (kind === "claude-cli") continue;

    test(`${kind} rater default resolves in the pinned pi-ai catalog`, () => {
      const [provider, modelId] = parseModelStr(modelString);
      const model = getBuiltinModel(
        provider as Parameters<typeof getBuiltinModel>[0],
        modelId as never,
      );
      expect(model).toBeDefined();
      expect(model.id).toBe(modelId);
      expect(model.provider).toBe(provider);
    });
  }

  test("MEMORY_RATER_MODEL still overrides every kind", () => {
    process.env.MEMORY_RATER_MODEL = "openrouter/anthropic/claude-sonnet-4-5";
    expect(resolveRaterModelString("openrouter")).toBe("openrouter/anthropic/claude-sonnet-4-5");
    expect(resolveRaterModelString("claude-cli")).toBe("openrouter/anthropic/claude-sonnet-4-5");
  });
});
