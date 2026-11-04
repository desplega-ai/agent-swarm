import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCombConfig } from "../comb/config";
import { getCombState, isAgentFsProxyEnabled, isCombEnabled } from "../utils/constants";

const ENV_KEYS = [
  "COMB_ENABLED",
  "AGENT_FS_API_URL",
  "AGENT_FS_PUBLIC_URL",
  "AGENT_FS_PROXY",
  "MCP_BASE_URL",
  "PUBLIC_MCP_BASE_URL",
];
const saved = new Map<string, string | undefined>();

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved.set(key, process.env[key]);
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = saved.get(key);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe("isAgentFsProxyEnabled", () => {
  test("defaults on only with a nonblank agent-fs URL", () => {
    expect(isAgentFsProxyEnabled()).toBe(false);
    process.env.AGENT_FS_API_URL = "  ";
    expect(isAgentFsProxyEnabled()).toBe(false);
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    expect(isAgentFsProxyEnabled()).toBe(true);
    process.env.AGENT_FS_PROXY = "false";
    expect(isAgentFsProxyEnabled()).toBe(false);
    delete process.env.AGENT_FS_API_URL;
    process.env.AGENT_FS_PROXY = "true";
    expect(isAgentFsProxyEnabled()).toBe(true);
  });
});

describe("getCombState", () => {
  test("nothing set: off, agent-fs missing", () => {
    expect(getCombState()).toEqual({
      enabled: false,
      explicit: false,
      reason: "AGENT_FS_API_URL is not set.",
    });
  });

  test("explicit true still needs AGENT_FS_API_URL", () => {
    process.env.COMB_ENABLED = "true";
    expect(isCombEnabled()).toBe(false);
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    expect(getCombState()).toEqual({ enabled: true, explicit: true, reason: null });
  });

  test("explicit false wins over every other setting", () => {
    process.env.COMB_ENABLED = "false";
    process.env.AGENT_FS_API_URL = "https://fs.example.com";
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com";
    process.env.AGENT_FS_PROXY = "true";
    expect(getCombState()).toMatchObject({ enabled: false, explicit: true });
  });

  test("unset: on whenever AGENT_FS_API_URL is set, with no reachability check", () => {
    for (const url of ["http://agent-fs:7433", "http://10.0.0.5:7433", "http://fs.svc:7433"]) {
      process.env.AGENT_FS_API_URL = url;
      expect(getCombState()).toEqual({ enabled: true, explicit: false, reason: null });
    }
    process.env.MCP_BASE_URL = "http://api:3013";
    expect(isCombEnabled()).toBe(true);
    process.env.AGENT_FS_PROXY = "false";
    expect(isCombEnabled()).toBe(true);
  });

  test("an unrecognized COMB_ENABLED counts as unset", () => {
    process.env.COMB_ENABLED = "treu";
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    expect(getCombState()).toMatchObject({ enabled: true, explicit: false });
  });
});

describe("getCombConfig apiUrl", () => {
  test("the proxy (default) gives <public API URL>/agentfs", () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.MCP_BASE_URL = "http://api:3013";
    expect(getCombConfig()).toMatchObject({ enabled: true, apiUrl: "http://api:3013/agentfs" });
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
    expect(getCombConfig().apiUrl).toBe("https://swarm.example.com/agentfs");
  });

  test("AGENT_FS_PUBLIC_URL wins over the proxy", () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com/";
    expect(getCombConfig().apiUrl).toBe("https://fs.example.com");
  });

  test("the proxy explicitly off: AGENT_FS_API_URL itself", () => {
    process.env.AGENT_FS_API_URL = "http://localhost:7433";
    process.env.AGENT_FS_PROXY = "false";
    expect(getCombConfig().apiUrl).toBe("http://localhost:7433");
  });
});
