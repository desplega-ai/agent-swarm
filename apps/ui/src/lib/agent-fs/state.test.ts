import { describe, expect, test } from "bun:test";
import type { StatusComb } from "../../api/types";
import { AgentFsError } from "./client";
import {
  type AgentFsStateInput,
  combEndpoint,
  deriveAgentFsState,
  fileRedirectPath,
  navRequirementMet,
} from "./state";
import type { MeResponse } from "./types";

const comb: StatusComb = {
  enabled: true,
  api_url: "http://fs.test",
  live_url: "https://live.test",
  org_id: "org-1",
  drive_id: "drive-1",
};

const me: MeResponse = {
  userId: "user-1",
  email: "human@example.com",
  displayName: "Human",
  defaultOrgId: null,
  defaultDriveId: null,
};

const base: AgentFsStateInput = {
  statusLoading: false,
  endpoint: "http://fs.test",
  hasCredential: true,
  me: undefined,
  meError: null,
};

describe("deriveAgentFsState", () => {
  test("a 401 gives invalid-key and beats a cached me", () => {
    const unauthorized = new AgentFsError(401, "UNAUTHORIZED", "bad key");
    expect(deriveAgentFsState({ ...base, meError: unauthorized })).toEqual({
      state: "invalid-key",
      error: unauthorized,
    });
    expect(deriveAgentFsState({ ...base, me, meError: unauthorized }).state).toBe("invalid-key");
  });

  test("a non-401 failure gives unreachable", () => {
    const down = new AgentFsError(0, "NETWORK", "Cannot reach agent-fs");
    expect(deriveAgentFsState({ ...base, meError: down })).toEqual({
      state: "unreachable",
      error: down,
    });
    const odd = deriveAgentFsState({ ...base, meError: new Error("boom") });
    expect(odd.state).toBe("unreachable");
    expect(odd.error?.status).toBe(0);
  });

  test("a failed background check keeps a cached me ready", () => {
    const down = new AgentFsError(503, "UNAVAILABLE", "down");
    expect(deriveAgentFsState({ ...base, me, meError: down })).toEqual({
      state: "ready",
      error: null,
    });
  });

  test("flag off gives disabled, even with a saved credential", () => {
    const endpoint = combEndpoint({ ...comb, enabled: false });
    expect(endpoint).toBeNull();
    expect(deriveAgentFsState({ ...base, endpoint, me }).state).toBe("disabled");
  });

  test("status loading, no credential, and a pending check", () => {
    expect(deriveAgentFsState({ ...base, statusLoading: true, endpoint: null }).state).toBe(
      "loading",
    );
    expect(deriveAgentFsState({ ...base, hasCredential: false }).state).toBe("needs-connect");
    expect(deriveAgentFsState(base)).toEqual({ state: "loading", error: null });
    expect(deriveAgentFsState({ ...base, me })).toEqual({ state: "ready", error: null });
  });
});

describe("combEndpoint and the sidebar rule", () => {
  test("Comb is on only with the flag and an agent-fs URL", () => {
    expect(combEndpoint(comb)).toBe("http://fs.test");
    expect(combEndpoint({ ...comb, api_url: null })).toBeNull();
    // An API that predates Comb has no comb block.
    expect(combEndpoint(undefined)).toBeNull();
  });

  test("a `requires: comb` item shows only while Comb is on", () => {
    expect(navRequirementMet("comb", comb)).toBe(true);
    expect(navRequirementMet("comb", { ...comb, enabled: false })).toBe(false);
    expect(navRequirementMet("comb", undefined)).toBe(false);
    expect(navRequirementMet(undefined, undefined)).toBe(true);
  });
});

describe("fileRedirectPath", () => {
  const drive = { endpoint: "http://fs.test", orgId: "org-1", driveId: "drive-1" };

  test("`/file` goes to the swarm drive once /status names it", () => {
    expect(fileRedirectPath(undefined, drive)).toBe("/file/~/org-1/drive-1/");
  });

  test("stays put with a drive in the URL, with Comb off, or without drive ids", () => {
    expect(fileRedirectPath("org-2", drive)).toBeNull();
    expect(fileRedirectPath(undefined, { ...drive, endpoint: null })).toBeNull();
    expect(fileRedirectPath(undefined, { ...drive, orgId: null })).toBeNull();
    expect(fileRedirectPath(undefined, { ...drive, driveId: null })).toBeNull();
  });
});
