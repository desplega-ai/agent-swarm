import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { type ApiConfig, ensureTaskFinished } from "../commands/runner";

// A schema-bound task whose agent answered with prose plus a ```json block
// instead of calling store-progress. The runner must recover the JSON itself
// rather than hand the task to the `claude -p` extraction fallback.

const outputSchema = {
  type: "object",
  required: ["jobId", "clusters"],
  properties: {
    jobId: { type: "string" },
    clusters: {
      type: "array",
      items: {
        type: "object",
        required: ["clusterId", "bullets"],
        properties: {
          clusterId: { type: "string" },
          bullets: {
            type: "array",
            items: {
              type: "object",
              required: ["claim", "stated", "src"],
              properties: {
                claim: { type: "string" },
                stated: { type: "string" },
                src: { type: "array", items: { type: "string" } },
              },
            },
          },
        },
      },
    },
  },
};

function bigResult() {
  const clusters = Array.from({ length: 6 }, (_, c) => ({
    clusterId: `c${c + 1}`,
    path: `/longterm/facts/example/subject-${c + 1}`,
    aliases: ["example"],
    bullets: Array.from({ length: 8 }, (_, b) => ({
      claim: `Example claim ${b + 1} for cluster ${c + 1}, long enough to resemble a real distilled fact.`,
      stated: "2026-01-02",
      src: [`00000000-0000-4000-8000-${String(c * 10 + b).padStart(12, "0")}`],
    })),
  }));
  return { jobId: "job-1", clusters };
}

let mockGetTask: Record<string, unknown> | null = null;
let lastFinishBody: Record<string, unknown> | null = null;
let extractionCalls = 0;
let originalFetch: typeof fetch;
let originalBunShell: typeof Bun.$;

const config: ApiConfig = {
  apiUrl: "http://runner-fenced-json.test",
  apiKey: "example-test-key",
  agentId: "test-agent-id",
};

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const { pathname } = new URL(url);
    const method = init?.method ?? "GET";
    if (method === "GET" && /^\/api\/tasks\/[^/]+$/.test(pathname) && mockGetTask) {
      return new Response(JSON.stringify(mockGetTask), {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (method === "POST" && /^\/api\/tasks\/[^/]+\/finish$/.test(pathname)) {
      lastFinishBody = JSON.parse(String(init?.body ?? "null"));
      return new Response(JSON.stringify({ success: true }), {
        headers: { "Content-Type": "application/json" },
      });
    }
    return new Response("Not found", { status: 404 });
  }) as typeof fetch;

  // The extraction fallback (`claude -p --json-schema`) must not be needed;
  // make it fail like the real one does when it cannot help.
  originalBunShell = Bun.$;
  Bun.$ = (() => {
    extractionCalls++;
    return {
      json: async () => {
        throw new Error("extraction fallback should not run");
      },
    };
  }) as unknown as typeof Bun.$;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  Bun.$ = originalBunShell;
});

beforeEach(() => {
  mockGetTask = {
    id: "task-fenced",
    task: "Distill the clusters",
    status: "in_progress",
    output: null,
    outputSchema,
    logs: [],
  };
  lastFinishBody = null;
  extractionCalls = 0;
});

describe("ensureTaskFinished with fenced JSON output", () => {
  test("recovers a prose line plus a large ```json block that matches outputSchema", async () => {
    const json = JSON.stringify(bigResult(), null, 2);
    expect(json.length).toBeGreaterThan(10_000);
    const finalText = `Looking at the 6 clusters, I'll distill each into atomic facts.\n\n\`\`\`json\n${json}\n\`\`\``;

    await ensureTaskFinished(config, "worker", "task-fenced", 0, undefined, finalText, "claude");

    expect(extractionCalls).toBe(0);
    expect(lastFinishBody?.status).toBe("completed");
    expect(JSON.parse(String(lastFinishBody?.output))).toEqual(bigResult());
  });

  test("recovers JSON after a prose line without a fence", async () => {
    const finalText = `Here is the result:\n${JSON.stringify(bigResult())}`;

    await ensureTaskFinished(config, "worker", "task-fenced", 0, undefined, finalText, "claude");

    expect(extractionCalls).toBe(0);
    expect(lastFinishBody?.status).toBe("completed");
    expect(JSON.parse(String(lastFinishBody?.output))).toEqual(bigResult());
  });

  test("keeps bare JSON output byte-for-byte", async () => {
    const finalText = `  ${JSON.stringify(bigResult())}\n`;

    await ensureTaskFinished(config, "worker", "task-fenced", 0, undefined, finalText, "claude");

    expect(lastFinishBody?.status).toBe("completed");
    expect(lastFinishBody?.output).toBe(finalText);
  });

  test("still fails when the fenced JSON does not match outputSchema", async () => {
    const finalText = `Done.\n\n\`\`\`json\n${JSON.stringify({ jobId: "job-1" })}\n\`\`\``;

    await ensureTaskFinished(config, "worker", "task-fenced", 0, undefined, finalText, "claude");

    expect(extractionCalls).toBe(1);
    expect(lastFinishBody?.status).toBe("failed");
    expect(lastFinishBody?.failureReason).toContain("Structured output extraction fallback failed");
  });
});
