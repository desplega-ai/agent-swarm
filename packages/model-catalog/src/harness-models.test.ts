import { describe, expect, test } from "bun:test";
import {
  fxModelRoute,
  type HarnessCatalogSections,
  harnessModelIds,
  harnessModelMismatch,
  isHarnessModelJudged,
  normalizeGrokModel,
} from "./index.ts";

const catalog: HarnessCatalogSections = {
  anthropic: {
    models: {
      "claude-opus-5-5": { release_date: "2026-08-01" },
      "claude-sonnet-5": { release_date: "2026-06-01" },
      "claude-haiku-4-5": { release_date: "2025-10-01" },
    },
  },
  openai: {
    models: {
      "gpt-6-luna": { release_date: "2026-09-01", reasoning: true },
      "gpt-5.6-sol": { release_date: "2026-05-01", reasoning: true },
      "gpt-5.6-terra": { release_date: "2026-05-01", reasoning: true },
      "gpt-5.6-luna": { release_date: "2026-05-01", reasoning: true },
      "gpt-5-nano": { release_date: "2025-08-01", reasoning: true },
    },
  },
  openrouter: {
    models: { "anthropic/claude-opus-5.5": { release_date: "2026-08-01" } },
  },
};

describe("harnessModelMismatch", () => {
  test("claude-opus-5-5 on codex fails and lists codex models", () => {
    const error = harnessModelMismatch("claude-opus-5-5", "codex", catalog, {
      agentName: "Reviewer 1",
      agentId: "a3b9cca2-1b37-9078-b000-000000000000",
    });
    expect(error).toContain("does not run on the codex harness");
    expect(error).toContain('of agent "Reviewer 1" (a3b9cca2-1b37-9078-b000-000000000000)');
    expect(error).toContain("gpt-");
    expect(error).toContain("Use modelTier (smol, regular, smart, ultra)");
  });

  test("gpt-5.6-sol on claude fails", () => {
    expect(harnessModelMismatch("gpt-5.6-sol", "claude", catalog)).toContain(
      "does not run on the claude harness",
    );
  });

  test("dated and latest Claude ids pass the family guard but stay out of pickers", () => {
    const models = {
      ...catalog.anthropic?.models,
      "claude-haiku-4-5-20251001": { release_date: "2025-10-01" },
      "claude-haiku-4-5-latest": { release_date: "2025-10-01" },
    };
    const sections = { ...catalog, anthropic: { models } };
    for (const id of ["claude-haiku-4-5-20251001", "claude-haiku-4-5-latest"]) {
      for (const harness of ["claude", "claude-managed"]) {
        expect(harnessModelMismatch(id, harness, sections)).toBeNull();
        expect(harnessModelMismatch(`anthropic/${id}[1m]`, harness, sections)).toBeNull();
        expect(harnessModelIds(harness, models)).toEqual(
          harnessModelIds(harness, catalog.anthropic?.models),
        );
      }
      expect(harnessModelMismatch(id, "codex", sections)).toContain(
        "does not run on the codex harness",
      );
    }
  });

  test("deprecated and pre-4 Claude ids still fail the family guard", () => {
    const models = {
      "claude-haiku-4-5-20251001": { status: "deprecated" },
      "claude-haiku-4-5-latest": { status: "deprecated" },
      "claude-3-5-sonnet-20241022": {},
      "claude-3-5-sonnet-latest": {},
      "claude-3-5-sonnet": {},
    };
    for (const id of Object.keys(models)) {
      for (const harness of ["claude", "claude-managed"]) {
        expect(harnessModelMismatch(id, harness, { anthropic: { models } })).toContain(
          `does not run on the ${harness} harness`,
        );
      }
    }
  });

  test("opus on claude passes (shortname)", () => {
    expect(harnessModelMismatch("opus", "claude", catalog)).toBeNull();
  });

  test("opus on codex passes (unknown to every section, rule 9)", () => {
    expect(harnessModelMismatch("opus", "codex", catalog)).toBeNull();
  });

  test("claude-opus-5-5[1m] on claude passes", () => {
    expect(harnessModelMismatch("claude-opus-5-5[1m]", "claude", catalog)).toBeNull();
  });

  test("latest:anthropic/opus on codex fails", () => {
    expect(harnessModelMismatch("latest:anthropic/opus", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
  });

  test("latest:openai/sol on codex passes", () => {
    expect(harnessModelMismatch("latest:openai/sol", "codex", catalog)).toBeNull();
  });

  test("openrouter/anthropic/claude-opus-5.5 on claude fails", () => {
    expect(
      harnessModelMismatch("openrouter/anthropic/claude-opus-5.5", "claude", catalog),
    ).toContain("does not run on the claude harness");
  });

  test("anthropic/claude-opus-5-5 on claude passes (own section prefix)", () => {
    expect(harnessModelMismatch("anthropic/claude-opus-5-5", "claude-managed", catalog)).toBeNull();
  });

  test("an uncatalogued id in the harness's own namespace passes; foreign and known-unsupported ids fail", () => {
    expect(harnessModelMismatch("openai/private-deployment-1", "codex", catalog)).toBeNull();
    expect(harnessModelMismatch("anthropic/claude-private-1", "claude", catalog)).toBeNull();
    expect(harnessModelMismatch("openai/gpt-5-nano", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
    expect(harnessModelMismatch("openai/claude-opus-5-5", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
    expect(harnessModelMismatch("anthropic/private-deployment-1", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
  });

  test("gpt-5-nano on codex fails (own section, excluded SKU)", () => {
    expect(harnessModelMismatch("gpt-5-nano", "codex", catalog)).toContain(
      "does not run on the codex harness",
    );
  });

  test("vendor-private-1 on codex passes (unknown everywhere)", () => {
    expect(harnessModelMismatch("vendor-private-1", "codex", catalog)).toBeNull();
  });

  test("any id on a free-form or unpinned harness passes", () => {
    for (const harness of ["pi", "devin", "acp", "dsh", "opencode", null, undefined]) {
      expect(harnessModelMismatch("claude-opus-5-5", harness, catalog)).toBeNull();
      expect(harnessModelMismatch("gpt-5.6-sol", harness, catalog)).toBeNull();
    }
  });

  test("the examples list has at most 8 ids and ends with ' and N more'", () => {
    const many: Record<string, { release_date: string; reasoning: boolean }> = {};
    for (let i = 0; i < 11; i++)
      many[`gpt-5.${i}-sol`] = { release_date: `2026-01-${10 + i}`, reasoning: true };
    const error = harnessModelMismatch("claude-opus-5-5", "codex", {
      ...catalog,
      openai: { models: many },
    });
    const examples = /for example: (.*?)\. Use modelTier/.exec(error ?? "")?.[1] ?? "";
    expect(examples.endsWith(" and 3 more")).toBe(true);
    expect(examples.replace(/ and 3 more$/, "").split(", ")).toHaveLength(8);
  });

  test("a small section lists every id with no suffix", () => {
    const error = harnessModelMismatch("gpt-6-luna", "claude", catalog) ?? "";
    expect(error).toContain("for example: claude-opus-5-5, claude-sonnet-5, claude-haiku-4-5. Use");
    expect(error).not.toContain("more");
    expect(error).not.toContain("of agent");
  });
});

describe("harnessModelMismatch on grok", () => {
  const withXai: HarnessCatalogSections = {
    ...catalog,
    xai: {
      models: {
        "grok-4.6": { release_date: "2026-09-01" },
        "grok-build-0.1": { release_date: "2026-08-01" },
        "grok-imagine-image": { release_date: "2026-07-01" },
      },
    },
  };

  test("xAI ids, bare or xai/-qualified, and the OpenRouter route pass", () => {
    for (const model of [
      "grok-4.6",
      "xai/grok-4.6",
      "XAI/grok-build-0.1",
      "openrouter/anthropic/claude-opus-5.5",
      "openrouter/deepseek/uncatalogued-1",
      "latest:openrouter/deepseek/deepseek-v4*",
      "grok-5-uncatalogued",
    ]) {
      expect(harnessModelMismatch(model, "grok", withXai)).toBeNull();
    }
  });

  test("another vendor's id, namespace or alias fails with the routes it accepts", () => {
    for (const model of [
      "claude-opus-5-5",
      "anthropic/claude-opus-5-5",
      "gpt-5.6-sol",
      "openai/gpt-5.6-sol",
      "anthropic/claude-opus-5.5",
      "xai/",
      "latest:anthropic/opus",
      "latest:openai/gpt-5*",
    ]) {
      const error = harnessModelMismatch(model, "grok", withXai, {
        agentName: "Grokker",
        agentId: "a3b9cca2-1b37-9078-b000-000000000001",
      });
      expect(error).toContain(`Model "${model}" does not run on the grok harness`);
      expect(error).toContain("(for example: grok-4.6, grok-build-0.1, grok-imagine-image)");
      expect(error).toContain("openrouter/<vendor>/<id>");
      expect(error).toContain('of agent "Grokker"');
    }
  });

  test("an xAI id that another section also lists still passes", () => {
    const shared: HarnessCatalogSections = {
      ...withXai,
      azure: { models: { "grok-4.6": {} } },
    };
    expect(harnessModelMismatch("grok-4.6", "grok", shared)).toBeNull();
  });
});

describe("normalizeGrokModel", () => {
  test("drops the xai/ prefix and nothing else", () => {
    expect(normalizeGrokModel(" xai/grok-4.6 ")).toBe("grok-4.6");
    expect(normalizeGrokModel("grok-4.6")).toBe("grok-4.6");
    expect(normalizeGrokModel("openrouter/x-ai/grok-4")).toBe("openrouter/x-ai/grok-4");
  });
});

describe("fxModelRoute", () => {
  test("routes openrouter/, vercel/ and bare ids to their fx provider and key", () => {
    expect(fxModelRoute("openrouter/deepseek/deepseek-v4.1-flash")).toEqual({
      fxProvider: "openrouter",
      fxModel: "deepseek/deepseek-v4.1-flash",
      keyVar: "OPENROUTER_API_KEY",
    });
    expect(fxModelRoute(" vercel/anthropic/claude-opus-5.5 ")).toEqual({
      fxProvider: "gateway",
      fxModel: "anthropic/claude-opus-5.5",
      keyVar: "AI_GATEWAY_API_KEY",
    });
    expect(fxModelRoute("gpt-5-mini")).toEqual({
      fxProvider: "openai",
      fxModel: "gpt-5-mini",
      keyVar: "OPENAI_API_KEY",
    });
  });

  test("rejects NaN, Helmcode, Anthropic-direct, other namespaces and empty values with a reason", () => {
    const reason = (model: string) => {
      const route = fxModelRoute(model);
      return "error" in route ? route.error : null;
    };
    expect(reason("nan/glm5.3-flash")).toContain("InconsistentFinishReason");
    expect(reason("helmcode/qwen3.6")).toContain("Helmcode is not verified on fx");
    expect(reason("anthropic/claude-opus-5-5")).toContain("Anthropic Messages API");
    expect(reason("openai/gpt-5-mini")).toContain('Model "openai/gpt-5-mini" has no fx route.');
    expect(reason("openrouter/")).toContain("has no fx route");
    expect(reason("  ")).toContain("An empty model has no fx route");
    for (const model of ["nan/x", "openai/x", "openrouter/"]) {
      expect(reason(model)).toContain("vercel/<vendor>/<id> (AI_GATEWAY_API_KEY)");
    }
  });
});

describe("harnessModelMismatch on fx", () => {
  test("is judged", () => {
    expect(isHarnessModelJudged("fx")).toBe(true);
  });

  test("the three routes, an uncatalogued bare id and openrouter/openai aliases pass", () => {
    for (const model of [
      "openrouter/anthropic/claude-opus-5.5",
      "openrouter/acme/uncatalogued",
      "vercel/anthropic/claude-opus-5.5",
      "gpt-5.6-sol",
      "gpt-uncatalogued",
      "latest:openrouter/deepseek/deepseek-v4*",
      "latest:openai/gpt-5*",
    ]) {
      expect(harnessModelMismatch(model, "fx", catalog)).toBeNull();
    }
  });

  test("another vendor's bare id, a claude shortname, an unrouted namespace or a latest:anthropic alias fails", () => {
    for (const [model, reason] of [
      ["claude-opus-5-5", "is in the anthropic catalog"],
      ["opus", "is in the anthropic catalog"],
      ["anthropic/claude-opus-5-5", "Anthropic Messages API"],
      ["nan/glm5.3-flash", "InconsistentFinishReason"],
      ["openai/gpt-5.6-sol", "has no fx route"],
      ["latest:anthropic/opus", "latest:anthropic alias"],
    ] as const) {
      const error = harnessModelMismatch(model, "fx", catalog, {
        agentName: "Fixer",
        agentId: "a3b9cca2-1b37-9078-b000-000000000002",
      });
      expect(error).toContain(`Model "${model}" does not run on the fx harness`);
      expect(error).toContain(reason);
      expect(error).toContain('of agent "Fixer"');
    }
  });
});
