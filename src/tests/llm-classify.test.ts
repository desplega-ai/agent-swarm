import { describe, expect, test } from "bun:test";
import type { LlmProvider } from "../workflows/llm-provider";
import { executeLlmClassify } from "../workflows/nodes/llm-classify";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeProvider(result: unknown): LlmProvider {
  return {
    async query<T>(_input: string, _schema: unknown): Promise<T> {
      return result as T;
    },
  };
}

function makeThrowingProvider(message: string): LlmProvider {
  return {
    async query<T>(): Promise<T> {
      throw new Error(message);
    },
  };
}

// ---------------------------------------------------------------------------
// executeLlmClassify()
// ---------------------------------------------------------------------------

describe("executeLlmClassify()", () => {
  const categories = ["bug", "feature", "question"];
  const ctx = { trigger: { title: "App crashes on startup" } };

  test("returns the classified category as nextPort", async () => {
    const provider = makeProvider({ category: "bug", confidence: 0.95 });
    const result = await executeLlmClassify(
      { prompt: "{{trigger.title}}", categories },
      ctx,
      provider,
    );

    expect(result.mode).toBe("instant");
    expect(result.nextPort).toBe("bug");
    expect((result.output as Record<string, unknown>).category).toBe("bug");
    expect((result.output as Record<string, unknown>).confidence).toBe(0.95);
  });

  test("interpolates the prompt using context before calling provider", async () => {
    let capturedInput = "";
    const provider: LlmProvider = {
      async query<T>(input: string, _schema: unknown): Promise<T> {
        capturedInput = input;
        return { category: "feature", confidence: 0.8 } as T;
      },
    };

    await executeLlmClassify({ prompt: "{{trigger.title}}", categories }, ctx, provider);

    expect(capturedInput).toContain("App crashes on startup");
    expect(capturedInput).toContain("bug, feature, question");
  });

  test("uses fallbackPort when provider throws", async () => {
    const provider = makeThrowingProvider("LLM unavailable");
    const result = await executeLlmClassify(
      { prompt: "some prompt", categories, fallbackPort: "question" },
      ctx,
      provider,
    );

    expect(result.mode).toBe("instant");
    expect(result.nextPort).toBe("question");
    expect((result.output as Record<string, unknown>).confidence).toBe(0);
    expect((result.output as Record<string, unknown>).error).toContain("LLM unavailable");
  });

  test("falls back to last category when no fallbackPort is set and provider throws", async () => {
    const provider = makeThrowingProvider("timeout");
    const result = await executeLlmClassify({ prompt: "some prompt", categories }, ctx, provider);

    // Last category is "question"
    expect(result.nextPort).toBe("question");
  });

  test("handles feature classification correctly", async () => {
    const provider = makeProvider({ category: "feature", confidence: 0.7 });
    const result = await executeLlmClassify(
      { prompt: "Add dark mode support", categories },
      {},
      provider,
    );

    expect(result.nextPort).toBe("feature");
  });
});
