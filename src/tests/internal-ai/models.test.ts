import { describe, expect, test } from "bun:test";
import { getBuiltinModel } from "@earendil-works/pi-ai/providers/all";
import { DEFAULT_MODEL, parseModelStr } from "../../utils/internal-ai/models.js";

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
