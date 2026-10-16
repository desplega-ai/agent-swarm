/**
 * Vercel AI Gateway (`vercel/<vendor>/<model>`) on pi and opencode: the full
 * chat catalog, and the one endpoint no env var or hand-written block can move.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  isAgentChatModel,
  OPENAI_COMPATIBLE_PROVIDERS,
  openAICompatibleBaseUrlVars,
  providerBaseUrl,
  providerForModel,
  withRegistryCatalogSections,
} from "@desplega/model-catalog";
import { buildCatalogEntries } from "../be/model-catalog-store";
import { isKnownCatalogModel } from "../be/model-validation";
import { buildModelsCatalog } from "../be/models-catalog";
import { loadModelsDevCache, type ModelsDevCache } from "../be/modelsdev-cache";
import snapshot from "../be/modelsdev-cache.json";
import { applyProviderKeySplice, type OpencodeConfig } from "../providers/opencode-adapter";
import { customProviderModelsBlock, writeSessionModelsJson } from "../providers/pi-mono-adapter";

const VERCEL = OPENAI_COMPATIBLE_PROVIDERS.vercel;
const ENDPOINT = "https://ai-gateway.vercel.sh/v1";
const WRONG = "https://ai-gateway.vercel.sh";
const raw = snapshot as unknown as ModelsDevCache;
const rawVercel = (raw.vercel?.models ?? {}) as Record<
  string,
  Parameters<typeof isAgentChatModel>[0]
>;
const chatIds = Object.keys(rawVercel).filter((id) => isAgentChatModel(rawVercel[id] ?? {}));

describe("Vercel AI Gateway catalog", () => {
  test("the snapshot carries non-chat rows, so the filter is exercised", () => {
    expect(rawVercel["voyage/voyage-code-3"]).toBeDefined();
    expect(chatIds.length).toBeGreaterThan(200);
    expect(chatIds.length).toBeLessThan(Object.keys(rawVercel).length);
  });

  test("pi lists every AI Gateway chat model, and no embedding or video model", () => {
    const block = customProviderModelsBlock(VERCEL);
    const ids = block.models.map((m) => m.id as string);
    expect(ids.sort()).toEqual([...chatIds].sort());
    expect(ids).toContain("zai/glm-5.3");
    expect(ids).toContain("moonshotai/kimi-k3");
    expect(ids).toContain("anthropic/claude-sonnet-4.6");
    expect(ids).not.toContain("voyage/voyage-code-3");
    expect(ids).not.toContain("klingai/kling-v3.0-t2v");
    const glm = block.models.find((m) => m.id === "zai/glm-5.3");
    expect(glm).toMatchObject({ contextWindow: 1000000, maxTokens: 1000000, reasoning: true });
    expect(block).toMatchObject({
      baseUrl: ENDPOINT,
      api: "openai-completions",
      apiKey: "$AI_GATEWAY_API_KEY",
    });
  });

  test("picker, live and validation catalogs drop non-chat Vercel rows", () => {
    const merged = withRegistryCatalogSections(raw);
    expect(Object.keys(merged.vercel?.models ?? {}).sort()).toEqual([...chatIds].sort());
    // OpenRouter is not a registry provider and keeps its full section.
    expect(Object.keys(merged.openrouter?.models ?? {}).length).toBe(
      Object.keys(raw.openrouter?.models ?? {}).length,
    );

    const live = buildCatalogEntries(raw, 0).filter((e) => e.provider === "vercel");
    expect(live.map((e) => e.modelId).sort()).toEqual([...chatIds].sort());

    const cache = loadModelsDevCache();
    if (!cache) throw new Error("snapshot missing");
    const catalog = buildModelsCatalog(cache) as Parameters<typeof isKnownCatalogModel>[1];
    expect(isKnownCatalogModel("vercel/zai/glm-5.3", catalog)).toBe(true);
    expect(isKnownCatalogModel("vercel/anthropic/claude-sonnet-4.6", catalog)).toBe(true);
    expect(isKnownCatalogModel("vercel/voyage/voyage-code-3", catalog)).toBe(false);
    expect(providerForModel("vercel/moonshotai/kimi-k3")?.id).toBe("vercel");
  });
});

describe("Vercel AI Gateway endpoint is fixed", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
  });

  test("VERCEL_BASE_URL is never read or forwarded", () => {
    expect(VERCEL.baseUrl).toBe(ENDPOINT);
    expect(providerBaseUrl(VERCEL, { VERCEL_BASE_URL: WRONG })).toBe(ENDPOINT);
    expect(openAICompatibleBaseUrlVars()).not.toContain("VERCEL_BASE_URL");
    expect(openAICompatibleBaseUrlVars()).toContain("NAN_BASE_URL");
  });

  test("opencode gets the key and no baseURL, even over a configured one", () => {
    const key = crypto.randomUUID();
    const config: OpencodeConfig = {
      model: "vercel/zai/glm-5.3",
      provider: { vercel: { options: { baseURL: WRONG } } },
    };
    const picked = applyProviderKeySplice(config, config.model, {
      AI_GATEWAY_API_KEY: key,
      VERCEL_BASE_URL: WRONG,
    });
    expect(picked?.key).toBe(key);
    expect(config.provider?.vercel).toEqual({ env: [], options: { apiKey: key } });
  });

  test("pi gets the Chat Completions endpoint over VERCEL_BASE_URL and a hand-written block", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-vercel-"));
    dirs.push(agentDir);
    await Bun.write(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: { vercel: { baseUrl: WRONG, api: "anthropic-messages", headers: { a: "b" } } },
      }),
    );
    const env = { AI_GATEWAY_API_KEY: "k", VERCEL_BASE_URL: WRONG };
    const session = await writeSessionModelsJson(agentDir, env, "vercel/vendor/brand-new-model");
    try {
      expect(session.modelsPath).toBeDefined();
      const written = await Bun.file(session.modelsPath as string).json();
      const block = written.providers.vercel;
      expect(block.baseUrl).toBe(ENDPOINT);
      expect(block.api).toBe("openai-completions");
      expect(block.headers).toEqual({ a: "b" });
      const ids = (block.models as { id: string }[]).map((m) => m.id);
      expect(ids).toContain("zai/glm-5.3");
      // An id the catalog does not know yet still resolves (bare entry).
      expect(ids).toContain("vendor/brand-new-model");
    } finally {
      await session.dispose();
    }
  });

  test("pi without a shared block also lands on the endpoint", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-vercel-"));
    dirs.push(agentDir);
    const session = await writeSessionModelsJson(agentDir, {
      AI_GATEWAY_API_KEY: "k",
      VERCEL_BASE_URL: WRONG,
    });
    try {
      const written = await Bun.file(session.modelsPath as string).json();
      expect(written.providers.vercel.baseUrl).toBe(ENDPOINT);
    } finally {
      await session.dispose();
    }
  });
});
