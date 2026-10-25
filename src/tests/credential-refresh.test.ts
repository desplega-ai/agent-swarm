import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  CREDENTIAL_RETRY_INTERVAL_MS,
  type CredentialRefreshState,
  credentialFingerprint,
  KEY_RECHECK_INTERVAL_MS,
  recheckableFailures,
  refreshCredentialStatus,
  reportKeyValidation,
} from "../commands/credential-refresh";
import * as credentials from "../commands/provider-credentials";
import { fetchResolvedEnv } from "../commands/runner";
import type { AgentCredStatus } from "../types";

const api = { apiUrl: "http://unused.test", apiKey: "test", agentId: crypto.randomUUID() };
const ready: AgentCredStatus = {
  ready: true,
  missing: [],
  satisfiedBy: "test",
  hint: null,
  liveTest: null,
  latestModel: null,
  reportedAt: 1,
  reportKind: "post_task",
  bedrock: null,
  acp: null,
};

describe("runner credential refresh", () => {
  let state: CredentialRefreshState;
  let build: ReturnType<typeof spyOn<typeof credentials, "buildCredStatusReport">>;
  let send: ReturnType<typeof spyOn<typeof credentials, "sendCredStatusReport">>;

  beforeEach(() => {
    state = {
      harnessProvider: "claude",
      ready: true,
      lastRefreshAt: 0,
      inFlight: false,
      fingerprint: credentialFingerprint({}),
      rejectedKeys: 0,
    };
    build = spyOn(credentials, "buildCredStatusReport").mockResolvedValue(ready);
    send = spyOn(credentials, "sendCredStatusReport").mockResolvedValue(undefined);
  });

  afterEach(() => mock.restore());

  test("a negative boot snapshot recovers on the retry interval", async () => {
    state.ready = false;
    await refreshCredentialStatus(api, state, "claude", {}, CREDENTIAL_RETRY_INTERVAL_MS - 1);
    expect(build).not.toHaveBeenCalled();
    await refreshCredentialStatus(api, state, "claude", {}, CREDENTIAL_RETRY_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.ready).toBe(true);
  });

  test("a changed credential fingerprint refreshes a ready worker immediately", async () => {
    const env = { ANTHROPIC_API_KEY: "test-pool-a,test-pool-b" };
    await refreshCredentialStatus(api, state, "claude", env, 1);
    expect(build).toHaveBeenCalledWith("claude", env, {}, "post_task");
    expect(state.fingerprint).toBe(credentialFingerprint(env));
    await refreshCredentialStatus(api, state, "claude", env, 2);
    expect(build).toHaveBeenCalledTimes(1);
    await refreshCredentialStatus(api, state, "claude", {}, 3);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("an unchanged fingerprint does not refresh a ready worker", async () => {
    await refreshCredentialStatus(api, state, "claude", {}, KEY_RECHECK_INTERVAL_MS);
    expect(build).not.toHaveBeenCalled();
  });

  test("fingerprints ignore environment order and unrelated values", () => {
    expect(credentialFingerprint({ ANTHROPIC_API_KEY: "test-a", PATH: "a" })).toBe(
      credentialFingerprint({ PATH: "b", ANTHROPIC_API_KEY: "test-a" }),
    );
    for (const key of ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL", "OPENAI_API_KEY"]) {
      expect(credentialFingerprint({ [key]: "changed" })).not.toBe(credentialFingerprint({}));
    }
  });

  test("resolved credential env preserves the full pool before selection", async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url) => {
      if (String(url).includes("/api/config/resolved")) {
        return Response.json({
          configs: [{ key: "ANTHROPIC_API_KEY", value: "test-aaa11,test-bbb22" }],
        });
      }
      return Response.json({ availableIndices: [1], rejectedIndices: [0] });
    }) as typeof fetch;
    try {
      const result = await fetchResolvedEnv(api.apiUrl, api.apiKey, api.agentId, {
        HARNESS_PROVIDER: "claude",
      });
      expect(result.credentialEnv.ANTHROPIC_API_KEY).toBe("test-aaa11,test-bbb22");
      expect(result.env.ANTHROPIC_API_KEY).toBe("test-bbb22");
      expect(result.credentialEnv).not.toBe(result.env);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("rejected keys refresh after ten minutes, even when the worker is ready", async () => {
    state.rejectedKeys = 1;
    await refreshCredentialStatus(api, state, "claude", {}, KEY_RECHECK_INTERVAL_MS - 1);
    expect(build).not.toHaveBeenCalled();
    await refreshCredentialStatus(api, state, "claude", {}, KEY_RECHECK_INTERVAL_MS);
    expect(build).toHaveBeenCalledTimes(1);
    expect(state.rejectedKeys).toBe(0);
  });

  test("a failed live test without per-key results remains eligible for recheck", async () => {
    build.mockResolvedValueOnce({
      ...ready,
      liveTest: { ok: false, error: "timeout", latency_ms: 1 },
    });
    await refreshCredentialStatus(api, state, "pi", {}, 1);
    expect(state.rejectedKeys).toBe(1);
  });

  test("refresh reports per-key results once per credential type", async () => {
    const keys = [
      {
        keyType: "ANTHROPIC_API_KEY",
        index: 0,
        suffix: "aaa11",
        ok: false,
        httpStatus: 401,
        latency_ms: 1,
      },
      { keyType: "ANTHROPIC_API_KEY", index: 1, suffix: "bbb22", ok: true, latency_ms: 1 },
      { keyType: "OPENAI_API_KEY", index: 0, suffix: "ccc33", ok: true, latency_ms: 1 },
    ];
    build.mockResolvedValueOnce({ ...ready, liveTest: { ok: false, latency_ms: 1, keys } });
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ success: true });
    }) as typeof fetch;
    try {
      await refreshCredentialStatus(api, state, "pi", {}, 1);
      expect(state.rejectedKeys).toBe(1);
      expect(requests).toHaveLength(2);
      expect(requests[0]!.url).toBe(`${api.apiUrl}/api/keys/report-validation`);
      expect(requests[0]!.init?.headers).toMatchObject({
        Authorization: `Bearer ${api.apiKey}`,
        "X-Agent-ID": api.agentId,
      });
      expect(JSON.parse(String(requests[0]!.init?.body))).toEqual({
        keyType: "ANTHROPIC_API_KEY",
        keys: [
          { keyIndex: 0, keySuffix: "aaa11", ok: false, httpStatus: 401 },
          { keyIndex: 1, keySuffix: "bbb22", ok: true },
        ],
      });
      expect(JSON.parse(String(requests[1]!.init?.body))).toEqual({
        keyType: "OPENAI_API_KEY",
        keys: [{ keyIndex: 0, keySuffix: "ccc33", ok: true }],
      });
      expect(requests[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("validation reporting contains HTTP and network failures", async () => {
    const originalFetch = globalThis.fetch;
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const fetchMock = mock<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockRejectedValueOnce(new Error("network unavailable"));
    globalThis.fetch = fetchMock as typeof fetch;
    try {
      await reportKeyValidation(api, [
        { keyType: "ANTHROPIC_API_KEY", index: 0, suffix: "aaa11", ok: true, latency_ms: 1 },
        { keyType: "OPENAI_API_KEY", index: 0, suffix: "bbb22", ok: true, latency_ms: 1 },
      ]);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("a failed readiness write is throttled and retried even when the snapshot is ready", async () => {
    send.mockRejectedValueOnce(new Error("HTTP 503"));
    await expect(refreshCredentialStatus(api, state, "pi", {}, 1)).rejects.toThrow("HTTP 503");
    await refreshCredentialStatus(api, state, "pi", {}, CREDENTIAL_RETRY_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    await refreshCredentialStatus(api, state, "pi", {}, CREDENTIAL_RETRY_INTERVAL_MS + 1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(state.ready).toBe(true);
    await refreshCredentialStatus(api, state, "pi", {}, 10 * CREDENTIAL_RETRY_INTERVAL_MS);
    expect(build).toHaveBeenCalledTimes(2);
  });

  test("a failed snapshot build is retried without another provider change", async () => {
    build.mockRejectedValueOnce(new Error("probe failed"));
    await expect(refreshCredentialStatus(api, state, "pi", {}, 1)).rejects.toThrow("probe failed");
    expect(send).not.toHaveBeenCalled();
    await refreshCredentialStatus(api, state, "pi", {}, CREDENTIAL_RETRY_INTERVAL_MS);
    expect(build).toHaveBeenCalledTimes(1);
    await refreshCredentialStatus(api, state, "pi", {}, CREDENTIAL_RETRY_INTERVAL_MS + 1);
    expect(send).toHaveBeenCalledTimes(1);
    expect(state.ready).toBe(true);
  });

  test("CRED_CHECK_DISABLE suppresses provider changes, recovery, and Bedrock refresh", async () => {
    state.ready = false;
    await refreshCredentialStatus(
      api,
      state,
      "pi",
      { CRED_CHECK_DISABLE: "1", BEDROCK_AUTH_MODE: "sdk" },
      600_000,
    );
    expect(build).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  test("slow reports cannot overlap or apply an invalidated provider snapshot", async () => {
    let finishBuild!: (snapshot: AgentCredStatus) => void;
    build.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishBuild = resolve;
        }),
    );
    const pending = refreshCredentialStatus(api, state, "pi", {}, 1);
    await refreshCredentialStatus(api, state, "pi", {}, 600_000);
    expect(build).toHaveBeenCalledTimes(1);
    // Same invalidation the runner performs when it swaps adapters mid-check.
    state.harnessProvider = null;
    await refreshCredentialStatus(api, state, "acp", {}, 600_001);
    expect(build).toHaveBeenCalledTimes(1);
    finishBuild(ready);
    await pending;
    expect(send).not.toHaveBeenCalled();
    await refreshCredentialStatus(api, state, "acp", {}, 600_002);
    expect(build).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenCalledTimes(1);
  });

  test("Bedrock enumeration retains its five-minute refresh when ready", async () => {
    state.harnessProvider = "pi";
    const env = { BEDROCK_AUTH_MODE: "sdk" };
    await refreshCredentialStatus(api, state, "pi", env, 300_000);
    expect(build).not.toHaveBeenCalled();
    await refreshCredentialStatus(api, state, "pi", env, 300_001);
    expect(build).toHaveBeenCalledTimes(1);
    await refreshCredentialStatus(api, state, "pi", env, 300_002);
    expect(build).toHaveBeenCalledTimes(1);
  });
});

describe("recheckableFailures", () => {
  const key = (keyType: string, ok: boolean) => ({
    keyType,
    index: 0,
    suffix: "abcde",
    ok,
    latency_ms: 1,
  });

  test("a Claude subscription token never joins the periodic recheck", () => {
    const liveTest = {
      ok: false,
      error: "rejected",
      latency_ms: 1,
      testedAt: 1,
      keys: [key("CLAUDE_CODE_OAUTH_TOKEN", false), key("ANTHROPIC_API_KEY", false)],
    };
    expect(recheckableFailures(liveTest)).toBe(1);
    expect(
      recheckableFailures({ ...liveTest, keys: [key("CLAUDE_CODE_OAUTH_TOKEN", false)] }),
    ).toBe(0);
  });

  test("a failed test without per-key results counts once", () => {
    expect(recheckableFailures({ ok: false, error: "x", latency_ms: 1, testedAt: 1 })).toBe(1);
    expect(recheckableFailures(null)).toBe(0);
  });
});
