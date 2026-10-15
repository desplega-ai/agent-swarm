import { describe, expect, test } from "bun:test";
import snapshot from "../be/modelsdev-cache.json";
import {
  modelForId,
  OPENAI_COMPATIBLE_PROVIDER_IDS,
  OPENAI_COMPATIBLE_PROVIDERS,
  providerForModel,
  providerKeyFromEnv,
} from "../providers/openai-compatible-providers";
import { NAN_KEY_VARS } from "../utils/credentials";

type SnapshotModel = {
  name: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input?: string[] };
  limit?: { context?: number; output?: number };
};
type SnapshotProvider = {
  api?: string;
  env?: string[];
  npm?: string;
  models: Record<string, SnapshotModel>;
};

describe("openai-compatible provider table", () => {
  test("providerForModel routes by exact prefix only", () => {
    expect(providerForModel("nan/glm5.3-flash")?.id).toBe("nan");
    expect(providerForModel("helmcode/gemma4")?.id).toBe("helmcode");
    expect(providerForModel("openrouter/nan/glm5.3")).toBeUndefined();
    expect(providerForModel("glm5.3")).toBeUndefined();
    expect(providerForModel("nanx/glm5.3")).toBeUndefined();
    expect(providerForModel("toString/x")).toBeUndefined();
    expect(providerForModel(undefined)).toBeUndefined();
  });

  test("modelForId finds table models and rejects unknown ids", () => {
    expect(modelForId("helmcode/qwen3.6")?.contextWindow).toBe(262144);
    expect(modelForId("nan/glm5.3-flash")?.maxOutputTokens).toBe(131072);
    expect(modelForId("helmcode/qwen3.8-flash")).toBeUndefined();
    expect(modelForId("nan/not-a-model")).toBeUndefined();
  });

  test("providerKeyFromEnv prefers the canonical var, then the alias", () => {
    const nan = OPENAI_COMPATIBLE_PROVIDERS.nan;
    expect(providerKeyFromEnv(nan, { HELMCODE_API_NAN: "alias" })).toBe("alias");
    expect(providerKeyFromEnv(nan, { NAN_API_KEY: "canon", HELMCODE_API_NAN: "alias" })).toBe(
      "canon",
    );
    expect(providerKeyFromEnv(nan, { NAN_API_KEY: "  " })).toBeUndefined();
    expect(providerKeyFromEnv(OPENAI_COMPATIBLE_PROVIDERS.helmcode, { NAN_API_KEY: "k" })).toBe(
      undefined,
    );
  });

  test("key vars agree with the credential module", () => {
    expect([
      OPENAI_COMPATIBLE_PROVIDERS.nan.envVar,
      ...OPENAI_COMPATIBLE_PROVIDERS.nan.aliasEnvVars,
    ]).toEqual([...NAN_KEY_VARS]);
  });

  // Worker code cannot read the catalog store, so the table duplicates the
  // snapshot sections. Keep the two from drifting.
  for (const id of OPENAI_COMPATIBLE_PROVIDER_IDS) {
    test(`${id} matches its modelsdev-cache.json section`, () => {
      const entry = OPENAI_COMPATIBLE_PROVIDERS[id];
      const section = (snapshot as unknown as Record<string, SnapshotProvider | undefined>)[id];
      expect(section).toBeDefined();
      if (!section) return;
      expect(section.api).toBe(entry.baseUrl);
      expect(section.env).toEqual([entry.envVar]);
      expect(section.npm).toBe(entry.npm);
      for (const model of entry.models) {
        const snap = section.models[model.id];
        expect(snap, `${id}/${model.id} missing from snapshot`).toBeDefined();
        if (!snap) continue;
        expect({
          name: model.name,
          contextWindow: model.contextWindow,
          maxOutputTokens: model.maxOutputTokens,
          reasoning: model.reasoning,
          input: [...model.input],
        }).toEqual({
          name: snap.name,
          contextWindow: snap.limit?.context,
          maxOutputTokens: snap.limit?.output,
          reasoning: snap.reasoning,
          input: (snap.modalities?.input ?? []).filter((m) => m === "text" || m === "image"),
        });
        expect(snap.tool_call).toBe(true);
      }
    });
  }
});
