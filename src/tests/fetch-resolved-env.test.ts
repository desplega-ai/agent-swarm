import { afterAll, beforeAll, describe, expect, test } from "bun:test";

/**
 * Tests for the fetchResolvedEnv() behavior used in runner.ts.
 *
 * Since fetchResolvedEnv is a private function, we replicate its logic here
 * and test against a real mock HTTP server to verify the contract.
 */

let server: ReturnType<typeof Bun.serve>;
const TEST_PORT = 13099;
const TEST_URL = `http://localhost:${TEST_PORT}`;

// Configurable response for the mock server
let mockResponse: { status: number; body: unknown } = {
  status: 200,
  body: { configs: [] },
};

beforeAll(() => {
  server = Bun.serve({
    port: TEST_PORT,
    fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === "/api/config/resolved") {
        return new Response(JSON.stringify(mockResponse.body), {
          status: mockResponse.status,
          headers: { "Content-Type": "application/json" },
        });
      }

      return new Response("Not found", { status: 404 });
    },
  });
});

afterAll(() => {
  server.stop(true);
});

/**
 * Replica of fetchResolvedEnv from runner.ts for testing.
 * This must stay in sync with the actual implementation.
 */
async function fetchResolvedEnv(
  apiUrl: string,
  apiKey: string,
  agentId: string,
  baseEnv: Record<string, string | undefined> = {},
): Promise<Record<string, string | undefined>> {
  if (!apiUrl || !agentId) return { ...baseEnv };

  try {
    const headers: Record<string, string> = { "X-Agent-ID": agentId };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

    const url = `${apiUrl}/api/config/resolved?agentId=${encodeURIComponent(agentId)}&includeSecrets=true`;
    const response = await fetch(url, { headers });

    if (!response.ok) {
      return { ...baseEnv };
    }

    const data = (await response.json()) as {
      configs: Array<{ key: string; value: string }>;
    };

    if (!data.configs?.length) return { ...baseEnv };

    const merged: Record<string, string | undefined> = { ...baseEnv };
    for (const config of data.configs) {
      merged[config.key] = config.value;
    }

    return merged;
  } catch {
    return { ...baseEnv };
  }
}

describe("fetchResolvedEnv", () => {
  test("returns baseEnv when apiUrl is empty", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv("", "key", "agent-1", baseEnv);
    expect(result).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when agentId is empty", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(TEST_URL, "key", "", baseEnv);
    expect(result).toEqual({ EXISTING: "value" });
  });

  test("merges API config over baseEnv", async () => {
    mockResponse = {
      status: 200,
      body: {
        configs: [
          { key: "NEW_VAR", value: "from-api" },
          { key: "OVERRIDE_VAR", value: "api-wins" },
        ],
      },
    };

    const baseEnv = { EXISTING: "keep", OVERRIDE_VAR: "original" };
    const result = await fetchResolvedEnv(TEST_URL, "key", "agent-1", baseEnv);

    expect(result.EXISTING).toBe("keep");
    expect(result.NEW_VAR).toBe("from-api");
    expect(result.OVERRIDE_VAR).toBe("api-wins");
  });

  test("returns baseEnv when API returns empty configs", async () => {
    mockResponse = { status: 200, body: { configs: [] } };

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(TEST_URL, "key", "agent-1", baseEnv);
    expect(result).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when API returns non-200", async () => {
    mockResponse = { status: 500, body: { error: "server error" } };

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(TEST_URL, "key", "agent-1", baseEnv);
    expect(result).toEqual({ EXISTING: "value" });
  });

  test("returns baseEnv when API is unreachable", async () => {
    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv("http://localhost:19999", "key", "agent-1", baseEnv);
    expect(result).toEqual({ EXISTING: "value" });
  });

  test("does not mutate the baseEnv object", async () => {
    mockResponse = {
      status: 200,
      body: { configs: [{ key: "NEW_VAR", value: "new" }] },
    };

    const baseEnv = { EXISTING: "value" };
    const result = await fetchResolvedEnv(TEST_URL, "key", "agent-1", baseEnv);

    // baseEnv should be untouched
    expect(baseEnv).toEqual({ EXISTING: "value" });
    expect(result.NEW_VAR).toBe("new");
  });

  test("handles multiple configs correctly", async () => {
    mockResponse = {
      status: 200,
      body: {
        configs: [
          { key: "VAR_A", value: "a" },
          { key: "VAR_B", value: "b" },
          { key: "VAR_C", value: "c" },
        ],
      },
    };

    const result = await fetchResolvedEnv(TEST_URL, "key", "agent-1", {});
    expect(result.VAR_A).toBe("a");
    expect(result.VAR_B).toBe("b");
    expect(result.VAR_C).toBe("c");
  });
});
