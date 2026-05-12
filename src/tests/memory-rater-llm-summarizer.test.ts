/**
 * Unit tests for the `runMemoryRater` helper extracted from `src/hooks/hook.ts`
 * in the PR #450 review-feedback amendment. The helper owns the OpenRouter
 * direct-HTTP path: request shape (model, `response_format: json_object`,
 * Authorization header), tolerant JSON parse on the assistant content, schema
 * validation, and the env-driven model override.
 *
 * All tests stub `fetch` — no network calls.
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MEMORY_RATER_MODEL,
  getMemoryRaterModel,
  MEMORY_RATER_JSON_SCHEMA,
  MEMORY_RATER_SCHEMA_NAME,
  runMemoryRater,
  tryParseLooseJson,
} from "../be/memory/raters/llm-summarizer";

function makeOpenRouterResponse(content: string, init: ResponseInit = { status: 200 }): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { role: "assistant", content } }],
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json" },
      ...init,
    },
  );
}

describe("getMemoryRaterModel", () => {
  test("returns the default when MEMORY_RATER_MODEL is unset", () => {
    expect(getMemoryRaterModel({})).toBe(DEFAULT_MEMORY_RATER_MODEL);
    expect(DEFAULT_MEMORY_RATER_MODEL).toBe("google/gemini-3-flash-preview");
  });

  test("returns the env override when set", () => {
    expect(getMemoryRaterModel({ MEMORY_RATER_MODEL: "anthropic/claude-haiku-4.5" })).toBe(
      "anthropic/claude-haiku-4.5",
    );
  });

  test("trims whitespace in the env override", () => {
    expect(getMemoryRaterModel({ MEMORY_RATER_MODEL: "   openai/gpt-5-mini   " })).toBe(
      "openai/gpt-5-mini",
    );
  });

  test("falls back to the default when env var is empty / whitespace-only", () => {
    expect(getMemoryRaterModel({ MEMORY_RATER_MODEL: "" })).toBe(DEFAULT_MEMORY_RATER_MODEL);
    expect(getMemoryRaterModel({ MEMORY_RATER_MODEL: "   " })).toBe(DEFAULT_MEMORY_RATER_MODEL);
  });

  test("respects process.env when no env arg is provided", () => {
    const prev = process.env.MEMORY_RATER_MODEL;
    process.env.MEMORY_RATER_MODEL = "fake/model-from-process-env";
    try {
      expect(getMemoryRaterModel()).toBe("fake/model-from-process-env");
    } finally {
      if (prev === undefined) delete process.env.MEMORY_RATER_MODEL;
      else process.env.MEMORY_RATER_MODEL = prev;
    }
  });
});

describe("tryParseLooseJson", () => {
  test("strict JSON parses unchanged", () => {
    expect(tryParseLooseJson('{"a":1}')).toEqual({ a: 1 });
  });

  test("strips ```json fences", () => {
    expect(tryParseLooseJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test("strips plain ``` fences", () => {
    expect(tryParseLooseJson('```\n{"a":1}\n```')).toEqual({ a: 1 });
  });

  test("recovers from prose preamble via brace-slice", () => {
    expect(tryParseLooseJson('Here you go: {"a":1}')).toEqual({ a: 1 });
  });

  test("recovers from preamble + trailing chatter via brace-slice", () => {
    expect(tryParseLooseJson('preamble\n{"a":1}\nthanks')).toEqual({ a: 1 });
  });

  test("returns null on genuine garbage", () => {
    expect(tryParseLooseJson("not json at all")).toBeNull();
  });

  test("returns null on broken JSON inside fences", () => {
    expect(tryParseLooseJson("```json\n{broken,}\n```")).toBeNull();
  });

  test("never throws — even on adversarial input", () => {
    expect(() => tryParseLooseJson("{[}}}}")).not.toThrow();
    expect(() => tryParseLooseJson("```")).not.toThrow();
    expect(() => tryParseLooseJson("")).not.toThrow();
  });
});

describe("runMemoryRater — request shape", () => {
  test("POSTs to OpenRouter chat-completions with the right model, strict json_schema response_format, and Authorization header", async () => {
    let capturedUrl: string | URL | Request | undefined;
    let capturedInit: RequestInit | undefined;
    const fakeFetch: typeof fetch = async (url, init) => {
      capturedUrl = url;
      capturedInit = init;
      return makeOpenRouterResponse(JSON.stringify({ summary: "ok", ratings: [] }));
    };

    const result = await runMemoryRater({
      prompt: "test prompt",
      apiKey: "test-api-key-123",
      fetchImpl: fakeFetch,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(String(capturedUrl)).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(capturedInit?.method).toBe("POST");

    const headers = capturedInit?.headers as Record<string, string>;
    expect(headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe("Bearer test-api-key-123");

    const body = JSON.parse(String(capturedInit?.body));
    expect(body.model).toBe(DEFAULT_MEMORY_RATER_MODEL);
    expect(body.messages).toEqual([{ role: "user", content: "test prompt" }]);

    // OpenRouter strict json_schema mode — assert the wrapper shape.
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe(MEMORY_RATER_SCHEMA_NAME);
    expect(body.response_format.json_schema.strict).toBe(true);
    // Schema is the canonical one derived from SummaryWithRatingsSchema.
    expect(body.response_format.json_schema.schema).toEqual(MEMORY_RATER_JSON_SCHEMA);
  });

  test("MEMORY_RATER_JSON_SCHEMA reflects SummaryWithRatingsSchema (key shape only)", () => {
    // Don't assert exact JSON Schema bytes — Zod's emitter can change with
    // version bumps. Lock down the contract that matters for the OpenRouter
    // call: top-level keys, required fields, additionalProperties: false,
    // and the per-rating shape.
    expect(MEMORY_RATER_JSON_SCHEMA.type).toBe("object");
    expect(MEMORY_RATER_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(Array.isArray(MEMORY_RATER_JSON_SCHEMA.required)).toBe(true);
    expect(MEMORY_RATER_JSON_SCHEMA.required as string[]).toEqual(
      expect.arrayContaining(["summary", "ratings"]),
    );
    const props = MEMORY_RATER_JSON_SCHEMA.properties as Record<string, Record<string, unknown>>;
    expect(props.summary.type).toBe("string");
    expect(props.ratings.type).toBe("array");
    const items = props.ratings.items as Record<string, unknown>;
    expect(items.type).toBe("object");
    expect(items.additionalProperties).toBe(false);
    const itemProps = items.properties as Record<string, Record<string, unknown>>;
    expect(itemProps.id.type).toBe("string");
    expect(itemProps.score.type).toBe("number");
    expect(itemProps.score.minimum).toBe(0);
    expect(itemProps.score.maximum).toBe(1);
    expect(itemProps.reasoning.type).toBe("string");
    // referencesSource is optional → present in properties but not required.
    expect(itemProps.referencesSource.type).toBe("string");
    expect(items.required as string[]).toEqual(
      expect.arrayContaining(["id", "score", "reasoning"]),
    );
    expect((items.required as string[]).includes("referencesSource")).toBe(false);
  });

  test("schema does NOT carry a $schema metadata key (OpenRouter rejects extras at the root)", () => {
    expect("$schema" in MEMORY_RATER_JSON_SCHEMA).toBe(false);
  });

  test("explicit `model` opt overrides the env default", async () => {
    let capturedBody: { model?: string } = {};
    const fakeFetch: typeof fetch = async (_url, init) => {
      capturedBody = JSON.parse(String(init?.body));
      return makeOpenRouterResponse(JSON.stringify({ summary: "x", ratings: [] }));
    };

    const result = await runMemoryRater({
      prompt: "p",
      apiKey: "k",
      model: "anthropic/claude-haiku-4.5",
      fetchImpl: fakeFetch,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.model).toBe("anthropic/claude-haiku-4.5");
    expect(capturedBody.model).toBe("anthropic/claude-haiku-4.5");
  });

  test("MEMORY_RATER_MODEL env var changes the model when no opt is passed", async () => {
    const prev = process.env.MEMORY_RATER_MODEL;
    process.env.MEMORY_RATER_MODEL = "openai/gpt-5-mini";
    try {
      let capturedBody: { model?: string } = {};
      const fakeFetch: typeof fetch = async (_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return makeOpenRouterResponse(JSON.stringify({ summary: "x", ratings: [] }));
      };
      const result = await runMemoryRater({
        prompt: "p",
        apiKey: "k",
        fetchImpl: fakeFetch,
      });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.model).toBe("openai/gpt-5-mini");
      expect(capturedBody.model).toBe("openai/gpt-5-mini");
    } finally {
      if (prev === undefined) delete process.env.MEMORY_RATER_MODEL;
      else process.env.MEMORY_RATER_MODEL = prev;
    }
  });
});

describe("runMemoryRater — response handling", () => {
  test("happy path — strict JSON content parses + validates", async () => {
    const fakeFetch: typeof fetch = async () =>
      makeOpenRouterResponse(
        JSON.stringify({
          summary: "found two patterns",
          ratings: [{ id: "mem-A", score: 0.9, reasoning: "directly answered" }],
        }),
      );

    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary).toBe("found two patterns");
    expect(result.data.ratings).toHaveLength(1);
    expect(result.data.ratings[0]!.score).toBeCloseTo(0.9, 6);
  });

  test("tolerant parser recovers from ```json fences (PR #447 regression)", async () => {
    const inner = JSON.stringify({
      summary: "fenced summary",
      ratings: [{ id: "m", score: 0.7, reasoning: "useful" }],
    });
    const fakeFetch: typeof fetch = async () =>
      makeOpenRouterResponse(`\`\`\`json\n${inner}\n\`\`\``);

    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary).toBe("fenced summary");
    expect(result.data.ratings[0]!.score).toBeCloseTo(0.7, 6);
  });

  test("tolerant parser recovers from prose preamble (PR #447 regression)", async () => {
    const inner = JSON.stringify({
      summary: "preambled summary",
      ratings: [{ id: "m", score: 0, reasoning: "irrelevant" }],
    });
    const fakeFetch: typeof fetch = async () =>
      makeOpenRouterResponse(`Here is the JSON:\n\n${inner}`);

    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.summary).toBe("preambled summary");
  });

  test("schema-invalid content returns ok:false / reason:'schema'", async () => {
    // score = 5 violates the [0, 1] range in SummaryWithRatingsSchema.
    const fakeFetch: typeof fetch = async () =>
      makeOpenRouterResponse(
        JSON.stringify({
          summary: "x",
          ratings: [{ id: "m", score: 5, reasoning: "bogus" }],
        }),
      );
    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("schema");
  });

  test("genuinely garbage content returns ok:false / reason:'parse'", async () => {
    const fakeFetch: typeof fetch = async () =>
      makeOpenRouterResponse("totally not JSON at all, just words");
    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse");
  });

  test("HTTP 5xx returns ok:false / reason:'http_error' with status", async () => {
    const fakeFetch: typeof fetch = async () => new Response("upstream blew up", { status: 502 });
    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("http_error");
      expect(result.status).toBe(502);
    }
  });

  test("transport failure returns ok:false / reason:'transport'", async () => {
    const fakeFetch: typeof fetch = async () => {
      throw new Error("ECONNREFUSED");
    };
    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("transport");
  });

  test("missing choices[0].message.content returns ok:false / reason:'empty_content'", async () => {
    const fakeFetch: typeof fetch = async () =>
      new Response(JSON.stringify({ choices: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    const result = await runMemoryRater({ prompt: "p", apiKey: "k", fetchImpl: fakeFetch });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("empty_content");
  });
});
