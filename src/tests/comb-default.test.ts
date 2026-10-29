import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getCombConfig } from "../comb/config";
import { getCombState, isBrowserReachableUrl, isCombEnabled } from "../utils/constants";

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

describe("isBrowserReachableUrl", () => {
  test("public hosts and addresses are reachable", () => {
    for (const url of [
      "https://fs.example.com",
      "https://fs.example.com:7433/",
      "http://8.8.8.8:7433",
      "http://172.32.0.1",
      "http://172.15.0.1",
      "http://[2001:db8::1]:7433",
      "http://[2606:4700::1111]:7433",
      "http://[::ffff:8.8.8.8]:7433",
      "http://[::ffff:7f00:1]:7433",
    ]) {
      expect(isBrowserReachableUrl(url)).toBe(true);
    }
  });

  test("loopback is reachable: a localhost URL is the local dev setup", () => {
    for (const url of ["http://localhost:7433", "http://127.0.0.1:7433", "http://[::1]:7433"]) {
      expect(isBrowserReachableUrl(url)).toBe(true);
    }
  });

  test("single-label docker hosts are not", () => {
    for (const url of ["http://agent-fs:7433", "http://agent-fs", "http://swarm-agent-fs:7433"]) {
      expect(isBrowserReachableUrl(url)).toBe(false);
    }
  });

  test("internal suffixes are not", () => {
    for (const url of [
      "http://agent-fs.railway.internal:7433",
      "http://agent-fs.internal",
      "http://agent-fs.default.svc:7433",
      "http://agent-fs.default.svc.cluster.local:7433",
      "http://agent-fs.internal.:7433",
    ]) {
      expect(isBrowserReachableUrl(url)).toBe(false);
    }
  });

  test("private, link-local and unique-local addresses are not", () => {
    for (const url of [
      "http://10.0.0.5:7433",
      "http://172.16.0.1",
      "http://172.31.255.255",
      "http://192.168.1.10:7433",
      "http://169.254.169.254",
      "http://[fd00::1]:7433",
      "http://[fe80::1]:7433",
      "http://[::ffff:10.0.0.5]:7433",
      "http://[::ffff:192.168.1.10]:7433",
      "http://[::ffff:172.16.0.1]:7433",
      "http://[::ffff:169.254.169.254]",
      "http://[::]:7433",
      "http://[ff02::1]:7433",
      "http://[ff00::1]:7433",
    ]) {
      expect(isBrowserReachableUrl(url)).toBe(false);
    }
  });

  test("an unparseable value is not reachable", () => {
    expect(isBrowserReachableUrl("agent-fs:7433")).toBe(false);
    expect(isBrowserReachableUrl("")).toBe(false);
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

  test("explicit true still needs AGENT_FS_API_URL, but not a browser-reachable one", () => {
    process.env.COMB_ENABLED = "true";
    expect(isCombEnabled()).toBe(false);
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    expect(getCombState()).toEqual({ enabled: true, explicit: true, reason: null });
  });

  test("explicit false wins over every reachable URL", () => {
    process.env.COMB_ENABLED = "false";
    process.env.AGENT_FS_API_URL = "https://fs.example.com";
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com";
    process.env.AGENT_FS_PROXY = "true";
    expect(getCombState()).toMatchObject({ enabled: false, explicit: true });
  });

  test("unset: the reachable-URL conditions decide", () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    expect(isCombEnabled()).toBe(false);
    process.env.AGENT_FS_PROXY = "true";
    expect(getCombState()).toMatchObject({ enabled: true, explicit: false });
    delete process.env.AGENT_FS_PROXY;
    process.env.AGENT_FS_PUBLIC_URL = "  ";
    expect(isCombEnabled()).toBe(false);
    process.env.AGENT_FS_PUBLIC_URL = "https://fs.example.com";
    expect(isCombEnabled()).toBe(true);
  });

  test("unset with the proxy on: the public API URL decides, not AGENT_FS_API_URL", () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    process.env.AGENT_FS_PROXY = "true";
    process.env.MCP_BASE_URL = "http://api:3013";
    const state = getCombState();
    expect(state).toMatchObject({ enabled: false, explicit: false });
    expect(state.reason).toContain("PUBLIC_MCP_BASE_URL");
    expect(getCombConfig()).toMatchObject({ enabled: false, apiUrl: "http://api:3013/agentfs" });
    process.env.PUBLIC_MCP_BASE_URL = "https://swarm.example.com";
    expect(getCombState()).toMatchObject({ enabled: true, explicit: false });
    expect(getCombConfig().apiUrl).toBe("https://swarm.example.com/agentfs");
    delete process.env.PUBLIC_MCP_BASE_URL;
    process.env.MCP_BASE_URL = "http://[::ffff:10.0.0.5]:3013";
    expect(isCombEnabled()).toBe(false);
    process.env.COMB_ENABLED = "true";
    expect(isCombEnabled()).toBe(true);
  });

  test("an unrecognized COMB_ENABLED counts as unset", () => {
    process.env.COMB_ENABLED = "treu";
    process.env.AGENT_FS_API_URL = "http://localhost:7433";
    expect(getCombState()).toMatchObject({ enabled: true, explicit: false });
    process.env.AGENT_FS_API_URL = "http://agent-fs:7433";
    expect(getCombState()).toMatchObject({ enabled: false, explicit: false });
  });
});
