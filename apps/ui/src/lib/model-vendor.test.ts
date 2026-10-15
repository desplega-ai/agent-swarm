import { describe, expect, test } from "bun:test";
import { modelVendor } from "./model-vendor";

describe("modelVendor: NaN and Helmcode are routes, the maker keeps its mark", () => {
  test("strips the route prefix and reads the maker", () => {
    expect(modelVendor("nan/glm5.3-flash")).toBe("zai");
    expect(modelVendor("helmcode/gemma4")).toBe("google");
    expect(modelVendor("helmcode/deepseek-v4-flash")).toBe("deepseek");
    expect(modelVendor("nan/deepseek-v4-flash")).toBe("deepseek");
    expect(modelVendor("helmcode/glm5.3")).toBe("zai");
  });

  test("makers without a mark stay unmarked, and the routes get none of their own", () => {
    expect(modelVendor("nan/qwen3.6")).toBeNull();
    expect(modelVendor("helmcode/qwen3.6")).toBeNull();
    expect(modelVendor("nan/mimo-v2.6-flash")).toBeNull();
    expect(modelVendor("nan")).toBeNull();
    expect(modelVendor("helmcode")).toBeNull();
    // A look-alike prefix is an unknown route: not stripped, so no maker mark.
    expect(modelVendor("nanx/glm5.3-flash")).toBe(modelVendor("acme/glm5.3-flash"));
    expect(modelVendor("nanx/glm5.3-flash")).toBeNull();
  });

  test("existing ids keep their maker", () => {
    expect(modelVendor("glm-4.6")).toBe("zai");
    expect(modelVendor("z-ai/glm-4.6")).toBe("zai");
    expect(modelVendor("openrouter/z-ai/glm-4.6")).toBe("zai");
    expect(modelVendor("gemini-3-flash-preview")).toBe("google");
    expect(modelVendor("openrouter/google/gemini-3-flash-preview")).toBe("google");
    expect(modelVendor("openrouter/google/gemma-3-27b-it")).toBe("google");
    expect(modelVendor("deepseek-v4-pro")).toBe("deepseek");
    expect(modelVendor("claude-opus-5-5")).toBe("anthropic");
    expect(modelVendor("gpt-5.6")).toBe("openai");
    expect(modelVendor("grok-4.6")).toBe("xai");
    expect(modelVendor("openrouter/qwen/qwen3-coder-flash")).toBeNull();
    expect(modelVendor("low")).toBe("amp");
  });
});
