import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { OpenAIEmbeddingProvider } from "../be/memory/providers/openai-embedding";
import { runMemoryRater } from "../be/memory/raters/llm-summarizer";
import { validateProviderCredentials } from "../commands/provider-credentials";
import { completeStructured } from "../utils/internal-ai/complete-structured";
import type { ExecutorDependencies, ExecutorInput } from "../workflows/executors/base";
import { executeRawLlm } from "../workflows/executors/raw-llm";
import { ValidateExecutor } from "../workflows/executors/validate";

/**
 * OpenRouter app attribution at each of our own HTTP call sites: present for
 * openrouter.ai, absent for a gateway, absent with OPENROUTER_APP_ATTRIBUTION=false.
 */

const ENV_KEYS = [
  "OPENROUTER_API_KEY",
  "OPENROUTER_BASE_URL",
  "OPENROUTER_APP_ATTRIBUTION",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "EMBEDDING_API_BASE_URL",
] as const;
const GATEWAY = "https://gateway.example.test/v1";

type Case = { name: string; env: Record<string, string>; attributed: boolean };
const CASES: Case[] = [
  { name: "openrouter.ai", env: {}, attributed: true },
  { name: "a gateway", env: { OPENROUTER_BASE_URL: GATEWAY }, attributed: false },
  { name: "the opt-out", env: { OPENROUTER_APP_ATTRIBUTION: "false" }, attributed: false },
];

let saved: Record<string, string | undefined> = {};
let requests: { url: string; headers: Headers }[] = [];
const origFetch = globalThis.fetch;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  for (const key of ENV_KEYS) delete process.env[key];
  requests = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push({ url: request.url, headers: request.headers });
    return new Response("bad request", { status: 400 });
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = origFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

function setEnv(env: Record<string, string>) {
  for (const [key, value] of Object.entries(env)) process.env[key] = value;
}

function expectAttribution(headers: Headers | undefined, attributed: boolean) {
  expect(headers).toBeDefined();
  if (attributed) {
    expect(headers?.get("http-referer")).toBe("https://agent-swarm.dev");
    expect(headers?.get("x-openrouter-title")).toBe("Agent Swarm");
    expect(headers?.get("x-openrouter-categories")).toBe("personal-agent,cloud-agent");
  } else {
    expect(headers?.has("http-referer")).toBe(false);
    expect(headers?.has("x-openrouter-title")).toBe(false);
    expect(headers?.has("x-openrouter-categories")).toBe(false);
  }
}

describe("memory rater (llm-summarizer)", () => {
  for (const c of CASES) {
    test(`${c.name}`, async () => {
      setEnv(c.env);
      await runMemoryRater({ prompt: "p", apiKey: "example-or-key" });
      expectAttribution(requests[0]?.headers, c.attributed);
    });
  }
});

describe("completeStructured (pi-ai path)", () => {
  for (const c of CASES) {
    test(`${c.name}`, async () => {
      let headers: Headers | undefined;
      await completeStructured({
        zodSchema: { safeParse: () => ({ success: false, error: new Error("x") }) } as never,
        toolSchema: { type: "object", properties: {} } as never,
        toolName: "record",
        toolDescription: "Record.",
        systemPrompt: "sys",
        userPrompt: "user",
        retries: 1,
        env: c.env,
        _credentialOverride: {
          kind: "openrouter",
          apiKey: "example-or-key",
          modelDefault: "openrouter/deepseek/deepseek-v4.1-flash",
        },
        _complete: async (_model, _context, options) => {
          headers = new Headers((options?.headers ?? {}) as Record<string, string>);
          throw new Error("stop");
        },
      });
      expectAttribution(headers, c.attributed);
    });
  }

  test("a non-OpenRouter credential gets no attribution", async () => {
    let headers: Headers | undefined;
    await completeStructured({
      zodSchema: { safeParse: () => ({ success: false, error: new Error("x") }) } as never,
      toolSchema: { type: "object", properties: {} } as never,
      toolName: "record",
      toolDescription: "Record.",
      systemPrompt: "sys",
      userPrompt: "user",
      retries: 1,
      env: {},
      _credentialOverride: {
        kind: "anthropic",
        apiKey: "example-ant-key",
        modelDefault: "anthropic/claude-sonnet-4-5",
      },
      _complete: async (_model, _context, options) => {
        headers = new Headers((options?.headers ?? {}) as Record<string, string>);
        throw new Error("stop");
      },
    });
    expectAttribution(headers, false);
  });
});

describe("workflow raw-llm and validate nodes", () => {
  const deps = { interpolate: (template: string) => template } as unknown as ExecutorDependencies;
  const meta = { runId: "run", stepId: "step", nodeId: "node" } as unknown as ExecutorInput["meta"];

  for (const c of CASES) {
    test(`raw-llm: ${c.name}`, async () => {
      setEnv({ OPENROUTER_API_KEY: "example-or-key", ...c.env });
      expect((await executeRawLlm({ prompt: "hi" })).status).toBe("failed");
      expect(
        requests[0]?.url.startsWith(c.env.OPENROUTER_BASE_URL ?? "https://openrouter.ai/"),
      ).toBe(true);
      expectAttribution(requests[0]?.headers, c.attributed);
    });

    test(`validate: ${c.name}`, async () => {
      setEnv({ OPENROUTER_API_KEY: "example-or-key", ...c.env });
      await new ValidateExecutor(deps).run({
        config: { targetNodeId: "a", prompt: "Is it valid?" },
        context: { a: "output" },
        meta,
      });
      expectAttribution(requests[0]?.headers, c.attributed);
    });
  }

  test("an OpenAI credential gets no attribution", async () => {
    setEnv({ OPENAI_API_KEY: "example-sk-openai" });
    await executeRawLlm({ prompt: "hi" });
    expect(requests[0]?.url.startsWith("https://api.openai.com/")).toBe(true);
    expectAttribution(requests[0]?.headers, false);
  });
});

describe("OpenRouter credential check (GET /models)", () => {
  for (const c of CASES) {
    test(`${c.name}`, async () => {
      setEnv(c.env);
      await validateProviderCredentials("grok", { OPENROUTER_API_KEY: "example-or-key" });
      expect(requests[0]?.url.endsWith("/models")).toBe(true);
      expectAttribution(requests[0]?.headers, c.attributed);
    });
  }
});

describe("OpenAI-compatible embedding provider", () => {
  const embedCases: Case[] = [
    {
      name: "an openrouter.ai base URL",
      env: { EMBEDDING_API_BASE_URL: "https://openrouter.ai/api/v1" },
      attributed: true,
    },
    { name: "the OpenAI default", env: {}, attributed: false },
    { name: "a gateway", env: { EMBEDDING_API_BASE_URL: GATEWAY }, attributed: false },
    {
      name: "the opt-out",
      env: {
        EMBEDDING_API_BASE_URL: "https://openrouter.ai/api/v1",
        OPENROUTER_APP_ATTRIBUTION: "0",
      },
      attributed: false,
    },
  ];
  for (const c of embedCases) {
    test(`${c.name}`, async () => {
      setEnv(c.env);
      const provider = new OpenAIEmbeddingProvider({ apiKey: "example-embed-key" });
      expect(await provider.embed("hello")).toBeNull();
      expectAttribution(requests[0]?.headers, c.attributed);
    });
  }
});
