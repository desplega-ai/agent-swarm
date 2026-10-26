import { afterEach, describe, expect, mock, test } from "bun:test";

const TEST_CONNECTION = { id: "test", apiUrl: "https://api.example.test", apiKey: "" };
// The client sends no request before a connection exists. A test sets this to null.
let activeConnection: typeof TEST_CONNECTION | null = TEST_CONNECTION;
// A test that needs a saved key sets one.
let config = { apiUrl: "https://api.example.test", apiKey: "" };

mock.module("@/lib/config", () => ({
  getConfig: () => config,
  getActiveConnection: () => activeConnection,
}));

const { api, ApprovalRespondError } = await import("./client");
const { subscribeKeyRejection } = await import("./access-rejection");
type ApprovalRespondError = InstanceType<typeof ApprovalRespondError>;

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  activeConnection = TEST_CONNECTION;
  config = { apiUrl: "https://api.example.test", apiKey: "" };
});

describe("a 401 from the API", () => {
  const KEY = "aswt_token-1234";
  const unauthorized = async () =>
    new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });

  /** Run `call`, return the access ids reported as rejected meanwhile. */
  async function rejections(call: () => Promise<unknown>): Promise<string[]> {
    const seen: string[] = [];
    const stop = subscribeKeyRejection((id) => seen.push(id));
    try {
      await call().catch(() => undefined);
    } finally {
      stop();
    }
    return seen;
  }

  test("reports the saved key as rejected", async () => {
    config = { apiUrl: "https://api.example.test", apiKey: KEY };
    globalThis.fetch = unauthorized as unknown as typeof fetch;
    expect(await rejections(() => api.whoami())).toEqual(["https://api.example.test|1234"]);
  });

  test("other statuses report nothing", async () => {
    config = { apiUrl: "https://api.example.test", apiKey: KEY };
    for (const status of [403, 404, 500]) {
      globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      expect(await rejections(() => api.whoami())).toEqual([]);
    }
  });

  test("checkAccess reads 401 as rejected, without reporting itself", async () => {
    config = { apiUrl: "https://api.example.test", apiKey: KEY };
    const urls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      urls.push(String(input));
      return unauthorized();
    }) as unknown as typeof fetch;
    let result: string | undefined;
    const seen = await rejections(async () => {
      result = await api.checkAccess(config);
    });
    expect(result).toBe("rejected");
    expect(seen).toEqual([]);
    expect(urls).toEqual(["https://api.example.test/api/whoami"]);
  });

  test("checkAccess reads any other answer as accepted (an older API answers 404)", async () => {
    for (const status of [200, 404, 500]) {
      globalThis.fetch = (async () => new Response("{}", { status })) as unknown as typeof fetch;
      expect(await api.checkAccess({ apiUrl: "https://api.example.test", apiKey: KEY })).toBe(
        "accepted",
      );
    }
  });
});

describe("before a connection exists", () => {
  test("rejects without sending a request", async () => {
    activeConnection = null;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;

    await expect(api.cancelApprovalRequest("request-id")).rejects.toThrow(
      "Not connected to an API yet",
    );
    expect(calls).toBe(0);
  });
});

describe("respondToApprovalRequest", () => {
  test("surfaces the server error message", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "Required responses missing or invalid: reason" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });

    await expect(api.respondToApprovalRequest("request-id", {})).rejects.toThrow(
      "Required responses missing or invalid: reason",
    );
  });

  test("carries the status of a refused answer", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "You are not one of this request's approvers" }), {
        status: 403,
        headers: { "Content-Type": "application/json" },
      });

    const error = await api.respondToApprovalRequest("request-id", {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApprovalRespondError);
    expect((error as ApprovalRespondError).status).toBe(403);
    expect((error as ApprovalRespondError).message).toBe(
      "You are not one of this request's approvers",
    );
  });

  test("sends the picked name only as the unverified respondedBy claim", async () => {
    let body: unknown;
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ approvalRequest: {} }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    await api.respondToApprovalRequest("request-id", { q1: true }, "taras@example.com");
    expect(body).toEqual({ responses: { q1: true }, respondedBy: "taras@example.com" });
  });

  test("falls back to the response status when the body has no error", async () => {
    globalThis.fetch = async () => new Response("Bad request", { status: 400 });

    await expect(api.respondToApprovalRequest("request-id", {})).rejects.toThrow(
      "Failed to respond to approval request: 400",
    );
  });
});

describe("cancelApprovalRequest", () => {
  test("posts the reason to the cancel route", async () => {
    let request: { url: string; method?: string; body?: unknown } | undefined;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      request = { url, method: init?.method, body: JSON.parse(String(init?.body)) };
      return new Response(
        JSON.stringify({ approvalRequest: {}, alreadyCancelled: false, runCancelled: false }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;

    await api.cancelApprovalRequest("request-id", "Discarded from the dashboard");

    expect(request).toEqual({
      url: "https://api.example.test/api/approval-requests/request-id/cancel",
      method: "POST",
      body: { reason: "Discarded from the dashboard" },
    });
  });

  test("throws with the status on a 409", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify({ error: "already resolved" }), { status: 409 });

    await expect(api.cancelApprovalRequest("request-id")).rejects.toThrow(
      "Failed to cancel approval request: 409",
    );
  });
});

describe("updateAgentRuntime", () => {
  test("treats a missing runtime route as an unsupported capability", async () => {
    globalThis.fetch = async () => new Response("Not found", { status: 404 });

    await expect(api.fetchAgentRuntime("agent-old-api")).resolves.toBeNull();
  });

  test("does not mask runtime authorization and server errors", async () => {
    for (const status of [403, 500]) {
      globalThis.fetch = async () => new Response("Failed", { status });
      await expect(api.fetchAgentRuntime("agent-error")).rejects.toThrow(
        `Failed to fetch agent runtime: ${status}`,
      );
    }
  });

  test("omits Claude transport when the caller does not provide the capability", async () => {
    globalThis.fetch = async (_url, init) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        harness_provider: "claude",
        model: "claude-haiku-4-5",
        allow_custom_model: false,
      });
      return Response.json({ id: "agent-claude" });
    };

    await api.updateAgentRuntime({
      id: "agent-claude",
      harnessProvider: "claude",
      model: "claude-haiku-4-5",
    });
  });

  test("sends a Claude transport override with repository context", async () => {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://api.example.test/api/agents/agent-claude/runtime?repoId=repo-1");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        harness_provider: "claude",
        model: "claude-opus-4-8",
        allow_custom_model: false,
        claude: { transport: "sdk" },
      });
      return Response.json({ id: "agent-claude" });
    };

    await api.updateAgentRuntime({
      id: "agent-claude",
      repoId: "repo-1",
      harnessProvider: "claude",
      model: "claude-opus-4-8",
      claude: { transport: "sdk" },
    });
  });

  test("sends ACP target configuration with its model knob", async () => {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://api.example.test/api/agents/agent-acp/runtime");
      expect(init?.method).toBe("PATCH");
      expect(JSON.parse(String(init?.body))).toEqual({
        harness_provider: "acp",
        model: "custom/model",
        allow_custom_model: false,
        reasoning_effort: null,
        acp: {
          target: "custom",
          command: "custom-agent",
          args: ["--acp"],
          envKeys: ["CUSTOM_API_KEY"],
          modelEnvKey: "CUSTOM_MODEL",
        },
      });
      return Response.json({ id: "agent-acp" });
    };

    await api.updateAgentRuntime({
      id: "agent-acp",
      harnessProvider: "acp",
      model: "custom/model",
      reasoningEffort: null,
      acp: {
        target: "custom",
        command: "custom-agent",
        args: ["--acp"],
        envKeys: ["CUSTOM_API_KEY"],
        modelEnvKey: "CUSTOM_MODEL",
      },
    });
  });
});

describe("submitFeedback", () => {
  const input = {
    submission_id: "attempt-stable-across-retries",
    user_id: "user-1",
    install_id: null,
    installed_at: null,
    org_name: "Acme",
    swarm_version: "1.138.0",
    newsletter_consent: false,
    submitted_at: "2026-09-04T12:00:00.000Z",
  };

  test("falls back to a simple opaque request when the readable request rejects", async () => {
    let call = 0;
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://proxy.example.test/v1/feedback");
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual(input);

      call += 1;
      if (call === 1) {
        expect(init?.mode).toBeUndefined();
        expect(init?.headers).toEqual({ "Content-Type": "application/json" });
        throw new TypeError("Failed to fetch");
      }

      expect(init?.mode).toBe("no-cors");
      expect(init?.headers).toEqual({ "Content-Type": "text/plain;charset=UTF-8" });
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
    expect(call).toBe(2);
  });

  test("accepts an opaque fallback response", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      if (call === 1) throw new TypeError("Failed to fetch");
      return { status: 0, type: "opaque" } as Response;
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
    expect(call).toBe(2);
  });

  test("uses the readable JSON response when CORS succeeds", async () => {
    globalThis.fetch = async (url, init) => {
      expect(url).toBe("https://proxy.example.test/v1/feedback");
      expect(init?.method).toBe("POST");
      expect(init?.mode).toBeUndefined();
      expect(init?.headers).toEqual({ "Content-Type": "application/json" });
      expect(JSON.parse(String(init?.body))).toEqual(input);
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).resolves.toBeUndefined();
  });

  test("leaves out profile values the proxy catalog does not list yet", async () => {
    let body: unknown;
    globalThis.fetch = async (_url, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 202 });
    };

    await api.submitFeedback("https://proxy.example.test/v1/feedback", {
      ...input,
      use_case: "content",
      user_function: "marketing",
      team_size: "2-10",
    });
    expect(body).toEqual({ ...input, team_size: "2-10" });

    await api.submitFeedback("https://proxy.example.test/v1/feedback", {
      ...input,
      use_case: "docs",
      user_function: "founder",
    });
    expect(body).toEqual({ ...input, use_case: "docs", user_function: "founder" });
  });

  test("allows HTTP feedback submissions to loopback hosts", async () => {
    globalThis.fetch = async (url) => {
      expect(url).toBe("http://localhost:3013/v1/feedback");
      return new Response(null, { status: 202 });
    };

    await expect(
      api.submitFeedback("http://localhost:3013/v1/feedback", input),
    ).resolves.toBeUndefined();
  });

  test("rejects unsafe feedback endpoints before fetching", async () => {
    let calls = 0;
    globalThis.fetch = async () => {
      calls += 1;
      return new Response(null, { status: 202 });
    };

    for (const endpoint of ["http://evil.example/v1/feedback", "not a URL"]) {
      await expect(api.submitFeedback(endpoint, input)).rejects.toThrow(
        "Invalid feedback endpoint",
      );
    }
    expect(calls).toBe(0);
  });

  test("surfaces a readable non-2xx response without falling back", async () => {
    let call = 0;
    globalThis.fetch = async () => {
      call += 1;
      return new Response(JSON.stringify({ code: "rate_limited" }), { status: 429 });
    };

    await expect(
      api.submitFeedback("https://proxy.example.test/v1/feedback", input),
    ).rejects.toThrow("Failed to submit feedback: 429");
    expect(call).toBe(1);
  });
});

describe("fetchWorkflowRun", () => {
  const body = {
    run: { id: "run-1", workflowId: "wf-1", status: "completed" },
    steps: [{ id: "step-1", runId: "run-1", nodeId: "poll", status: "completed" }],
  };

  function captureUrl(): { url?: string } {
    const seen: { url?: string } = {};
    globalThis.fetch = (async (url: string) => {
      seen.url = url;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;
    return seen;
  }

  test("reads the full run by default", async () => {
    const seen = captureUrl();
    const run = await api.fetchWorkflowRun("run-1");
    expect(seen.url).toBe("https://api.example.test/api/workflow-runs/run-1");
    expect(run).toEqual({ ...body.run, steps: body.steps, parent: undefined });
  });

  test("the slim read asks for fields=slim and keeps the same shape", async () => {
    const seen = captureUrl();
    const run = await api.fetchWorkflowRunSlim("run-1");
    expect(seen.url).toBe("https://api.example.test/api/workflow-runs/run-1?fields=slim");
    expect(run).toEqual({ ...body.run, steps: body.steps, parent: undefined });
  });
});
