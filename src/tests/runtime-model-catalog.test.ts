import { afterEach, describe, expect, test } from "bun:test";
import {
  getClaudeManagedModelPricing,
  listClaudeManagedModels,
} from "../providers/claude-managed-models";
import {
  getCodexContextWindow,
  getCodexModelPricing,
  listCodexModels,
} from "../providers/codex-models";
import {
  refreshRuntimeModelCatalog,
  resetRuntimeModelCatalogForTests,
  setRuntimeModelCatalog,
} from "../utils/runtime-model-catalog";

const NEW_CODEX = "gpt-9-test";
const NEW_CLAUDE = "claude-opus-9";

const liveCatalog = {
  openai: {
    id: "openai",
    models: {
      [NEW_CODEX]: {
        id: NEW_CODEX,
        cost: { input: 3, output: 12 },
        limit: { context: 2_000_000 },
        release_date: "2099-01-01",
        reasoning: true,
      },
    },
  },
  anthropic: {
    id: "anthropic",
    models: {
      [NEW_CLAUDE]: {
        id: NEW_CLAUDE,
        cost: { input: 6, output: 30, cache_read: 0.6, cache_write: 7.5 },
        limit: { context: 1_000_000 },
        release_date: "2099-01-01",
      },
    },
  },
};

afterEach(() => resetRuntimeModelCatalogForTests());

describe("runtime model catalog", () => {
  test("a model unknown to the snapshot becomes listed, priced and windowed once the live catalog has it", () => {
    expect(listCodexModels()).not.toContain(NEW_CODEX);
    expect(getCodexModelPricing(NEW_CODEX)).toBeUndefined();

    setRuntimeModelCatalog(liveCatalog);

    expect(listCodexModels()[0]).toBe(NEW_CODEX);
    expect(getCodexModelPricing(NEW_CODEX)).toMatchObject({
      inputPerMillion: 3,
      outputPerMillion: 12,
    });
    expect(getCodexContextWindow(NEW_CODEX)).toBe(2_000_000);
    expect(listClaudeManagedModels()).toContain(NEW_CLAUDE);
    expect(getClaudeManagedModelPricing(NEW_CLAUDE)).toEqual({
      inputPerMillion: 6,
      outputPerMillion: 30,
      cacheReadPerMillion: 0.6,
      cacheWritePerMillion: 7.5,
    });
  });

  test("worker pull from GET /api/models-catalog installs the live layer; failures keep the snapshot", async () => {
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch;
    expect(await refreshRuntimeModelCatalog({ apiUrl: "http://x", fetchImpl: failing })).toBe(
      false,
    );
    expect(getCodexModelPricing(NEW_CODEX)).toBeUndefined();

    let url = "";
    const ok = (async (input: string | URL | Request) => {
      url = String(input);
      return Response.json({ source: "live", providers: liveCatalog });
    }) as unknown as typeof fetch;
    expect(await refreshRuntimeModelCatalog({ apiUrl: "http://x", fetchImpl: ok })).toBe(true);
    expect(url).toBe("http://x/api/models-catalog");
    expect(getCodexModelPricing(NEW_CODEX)?.inputPerMillion).toBe(3);
  });
});
