import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  CREDENTIAL_RETRY_INTERVAL_MS,
  type CredentialRefreshState,
  refreshCredentialStatus,
} from "../commands/credential-refresh";
import * as credentials from "../commands/provider-credentials";
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
    state = { harnessProvider: "claude", ready: true, lastRefreshAt: 0, inFlight: false };
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
