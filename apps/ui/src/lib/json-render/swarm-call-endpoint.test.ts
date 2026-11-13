import { beforeEach, describe, expect, mock, test } from "bun:test";
import { join } from "node:path";

// Every `@/` specifier maps to its real file (bun does not resolve vite's alias).
const SRC = join(import.meta.dir, "../..");
for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync(SRC)) {
  if (/\.test\.tsx?$/.test(file)) continue;
  const specifier = `@/${file.replace(/\.tsx?$/, "").replace(/\/index$/, "")}`;
  if (specifier === "@/lib/config") continue;
  mock.module(specifier, async () => await import(join(SRC, file)));
}

// Dummy connection: an API URL with no explicit port or path.
let apiUrl = "https://api.example.test";
const API_KEY = "dummy-bearer";
mock.module("@/lib/config", () => ({ getConfig: () => ({ apiUrl, apiKey: API_KEY }) }));

const { createSwarmActionHandlers } = await import("./swarm-actions");

type Recorded = { url: string; auth: string | undefined };
let recorded: Recorded[];

const recordingFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const headers = (init?.headers ?? {}) as Record<string, string>;
  recorded.push({ url: String(input), auth: headers.Authorization });
  return new Response("{}", { status: 200 });
}) as typeof fetch;

async function call(endpoint: string): Promise<void> {
  const handlers = createSwarmActionHandlers({
    fetchImpl: recordingFetch,
    onResponse: () => {},
    onError: () => {},
  });
  try {
    await handlers["swarm.call"]({ method: "GET", endpoint });
  } catch {
    // A rejected call may halt the chain by throwing; only the fetch record matters here.
  }
}

beforeEach(() => {
  recorded = [];
  apiUrl = "https://api.example.test";
});

describe("swarm.call stays on the API origin", () => {
  test("control: a leading-slash endpoint goes to the API origin with the bearer", async () => {
    await call("/api/tasks");
    expect(recorded).toEqual([
      { url: "https://api.example.test/api/tasks", auth: `Bearer ${API_KEY}` },
    ]);
  });

  test("an endpoint without a leading slash never sends the bearer to another origin", async () => {
    await call(".other.example/api/tasks");
    for (const r of recorded) {
      expect(new URL(r.url).origin).toBe(new URL(apiUrl).origin);
    }
    expect(recorded).toEqual([]);
  });

  test("an absolute or protocol-relative endpoint is rejected without a fetch", async () => {
    await call("//other.example/api/tasks");
    await call("https://other.example/api/tasks");
    expect(recorded).toEqual([]);
  });
});
