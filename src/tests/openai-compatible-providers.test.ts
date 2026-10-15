import { describe, expect, test } from "bun:test";
import {
  baseUrlEnvVar,
  OPENAI_COMPATIBLE_PROVIDERS,
  openAICompatibleProviderIds,
  providerBaseUrl,
  providerForKeyVar,
  providerForModel,
  providerKeyFromEnv,
  withRegistryCatalogSections,
} from "@desplega/model-catalog";
import { loadModelsDevCache } from "../be/modelsdev-cache";
import snapshot from "../be/modelsdev-cache.json";
import { applyProviderKeySplice, type OpencodeConfig } from "../providers/opencode-adapter";
import { customProviderModelsBlock } from "../providers/pi-mono-adapter";
import { normalizeProviderKeyAliases } from "../utils/credentials";

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
  test("Vercel preserves gateway model namespaces and uses the picked key in both harnesses", () => {
    const model = "vercel/zai/glm-5.3";
    const provider = providerForModel(model);
    expect(provider?.id).toBe("vercel");
    if (!provider) throw new Error("Vercel provider missing");
    const key = crypto.randomUUID();
    const config: OpencodeConfig = { model };
    expect(applyProviderKeySplice(config, model, { AI_GATEWAY_API_KEY: key })?.key).toBe(key);
    expect(config.provider?.vercel).toEqual({ env: [], options: { apiKey: key } });
    // Keep OpenCode's built-in Gateway SDK endpoint; pi needs the OpenAI endpoint.
    const pi = customProviderModelsBlock(provider);
    expect(pi.baseUrl).toBe("https://ai-gateway.vercel.sh/v1");
    expect(pi.api).toBe("openai-completions");
    expect(pi.apiKey).toBe("$AI_GATEWAY_API_KEY");
    expect(pi.models.map((m) => m.id)).toEqual(["zai/glm-5.3", "moonshotai/kimi-k3"]);
  });

  test("providerForModel routes by exact prefix only", () => {
    expect(providerForModel("nan/glm5.3-flash")?.id).toBe("nan");
    expect(providerForModel("helmcode/gemma4")?.id).toBe("helmcode");
    expect(providerForModel("openrouter/nan/glm5.3")).toBeUndefined();
    expect(providerForModel("glm5.3")).toBeUndefined();
    expect(providerForModel("nanx/glm5.3")).toBeUndefined();
    expect(providerForModel("toString/x")).toBeUndefined();
    expect(providerForModel(undefined)).toBeUndefined();
  });

  test("providerForKeyVar finds canonical and alias key vars", () => {
    expect(providerForKeyVar("NAN_API_KEY")?.id).toBe("nan");
    expect(providerForKeyVar("HELMCODE_API_NAN")?.id).toBe("nan");
    expect(providerForKeyVar("HELMCODE_API_KEY")?.id).toBe("helmcode");
    expect(providerForKeyVar("OPENROUTER_API_KEY")).toBeUndefined();
  });

  test("<ID>_BASE_URL overrides the default base URL", () => {
    const nan = OPENAI_COMPATIBLE_PROVIDERS.nan;
    const helmcode = OPENAI_COMPATIBLE_PROVIDERS.helmcode;
    expect(baseUrlEnvVar(nan)).toBe("NAN_BASE_URL");
    expect(baseUrlEnvVar(helmcode)).toBe("HELMCODE_BASE_URL");
    expect(providerBaseUrl(nan, {})).toBe("https://api.nan.builders/v1");
    expect(providerBaseUrl(nan, { NAN_BASE_URL: "  " })).toBe("https://api.nan.builders/v1");
    expect(providerBaseUrl(helmcode, { HELMCODE_BASE_URL: "http://127.0.0.1:9/v1/" })).toBe(
      "http://127.0.0.1:9/v1",
    );
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

  test("normalizeProviderKeyAliases copies an alias only into an empty canonical var", () => {
    const aliasOnly: Record<string, string | undefined> = { HELMCODE_API_NAN: "alias" };
    normalizeProviderKeyAliases(aliasOnly);
    expect(aliasOnly.NAN_API_KEY).toBe("alias");
    const both: Record<string, string | undefined> = {
      NAN_API_KEY: "canon",
      HELMCODE_API_NAN: "alias",
    };
    normalizeProviderKeyAliases(both);
    expect(both.NAN_API_KEY).toBe("canon");
  });

  test("registry-sourced sections are synthesized, never hand-written in the snapshot", () => {
    const raw = snapshot as unknown as Record<string, unknown>;
    for (const id of openAICompatibleProviderIds()) {
      const entry = OPENAI_COMPATIBLE_PROVIDERS[id];
      if (entry.catalog === "registry") expect(raw[id]).toBeUndefined();
      else expect(raw[id]).toBeDefined();
    }
    // The server loader carries the synthesized sections.
    expect(loadModelsDevCache()?.helmcode?.models?.["glm5.3"]?.limit?.context).toBe(1048576);
  });

  // The registry duplicates the models.dev sections of `catalog: "models.dev"`
  // entries (the pi/opencode blocks need limits the worker cannot read from
  // the catalog store); keep the two from drifting. Registry-sourced sections
  // are built from the registry, so they agree by construction.
  const merged = withRegistryCatalogSections(
    snapshot as unknown as Record<string, SnapshotProvider | undefined>,
  );
  for (const id of openAICompatibleProviderIds()) {
    test(`${id} matches its catalog section`, () => {
      const entry = OPENAI_COMPATIBLE_PROVIDERS[id];
      const section = merged[id];
      expect(section).toBeDefined();
      if (!section) return;
      // Built-in SDK providers such as Vercel can omit an OpenAI API URL.
      if (section.api) expect(section.api).toBe(entry.baseUrl);
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
