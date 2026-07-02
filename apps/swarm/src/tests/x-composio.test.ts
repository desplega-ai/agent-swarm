import { describe, expect, mock, test } from "bun:test";

import { parseComposioArgs, runComposioCommand, runXCommand } from "../commands/x";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("parseComposioArgs", () => {
  test("parses method, path, body, query, and base url", () => {
    const parsed = parseComposioArgs(
      [
        "POST",
        "/tools/execute/GITHUB_CREATE_AN_ISSUE",
        "--body",
        '{"arguments":{"title":"demo"}}',
        "--query",
        "preview=true",
        "--base-url",
        "https://example.test/api",
      ],
      {},
    );

    expect(parsed.method).toBe("POST");
    expect(parsed.endpoint).toBe("/tools/execute/GITHUB_CREATE_AN_ISSUE");
    expect(parsed.body).toEqual({ arguments: { title: "demo" } });
    expect(parsed.query).toEqual([["preview", "true"]]);
    expect(parsed.baseUrl).toBe("https://example.test/api");
  });

  test("rejects absolute endpoint URLs so API keys are not routed elsewhere", () => {
    expect(() => parseComposioArgs(["GET", "https://evil.example/tools"], {})).toThrow(
      "endpoint must be a Composio API path",
    );
  });
});

describe("runComposioCommand", () => {
  test("routes request to Composio with x-api-key auth and pretty JSON output", async () => {
    const out: string[] = [];
    const fetchMock = mock(async (url: string | URL | Request, init?: RequestInit) => {
      expect(String(url)).toBe("https://backend.composio.dev/api/v3.1/tools?limit=10");
      expect(init?.method).toBe("GET");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBe("ck_test_secret");
      return jsonResponse({ ok: true, token: "ck_test_secret" });
    });

    await runComposioCommand(["GET", "/tools", "--query", "limit=10"], {
      env: { COMPOSIO_API_KEY: "ck_test_secret" },
      fetch: fetchMock,
      log: (message) => out.push(message),
      error: (message) => out.push(message),
      exit: () => {
        throw new Error("should not exit");
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(out.join("\n")).toContain('"ok": true');
    expect(out.join("\n")).toContain("[REDACTED:COMPOSIO_API_KEY]");
    expect(out.join("\n")).not.toContain("ck_test_secret");
  });

  test("uses org key header when --org is passed", async () => {
    const fetchMock = mock(async (_url: string | URL | Request, init?: RequestInit) => {
      expect((init?.headers as Record<string, string>)["x-org-api-key"]).toBe("org_secret_value");
      expect((init?.headers as Record<string, string>)["x-api-key"]).toBeUndefined();
      return jsonResponse({ ok: true });
    });

    await runComposioCommand(["GET", "/org/projects", "--org"], {
      env: { COMPOSIO_ORG_API_KEY: "org_secret_value" },
      fetch: fetchMock,
      log: () => {},
      error: () => {},
      exit: () => {
        throw new Error("should not exit");
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("exits before fetch when COMPOSIO_API_KEY is missing", async () => {
    const err: string[] = [];
    const exit = mock(() => undefined);
    const fetchMock = mock(async () => jsonResponse({ ok: true }));

    await runComposioCommand(["GET", "/tools"], {
      env: {},
      fetch: fetchMock,
      log: () => {},
      error: (message) => err.push(message),
      exit,
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(exit).toHaveBeenCalledWith(1);
    expect(err.join("\n")).toContain("COMPOSIO_API_KEY is required");
  });
});

describe("runXCommand", () => {
  test("dispatches to composio target", async () => {
    const fetchMock = mock(async () => jsonResponse({ ok: true }));
    await runXCommand(["composio", "GET", "/tools"], {
      env: { COMPOSIO_API_KEY: "ck_test_secret" },
      fetch: fetchMock,
      log: () => {},
      error: () => {},
      exit: () => {
        throw new Error("should not exit");
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
