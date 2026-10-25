import { describe, expect, test } from "bun:test";
import {
  addressSpaceOf,
  isLocalNetworkUrl,
  isSafari,
  needsLocalNetworkPermission,
  withAddressSpace,
} from "./local-network";

describe("addressSpaceOf", () => {
  test("loopback: localhost names, 127/8, ::1", () => {
    expect(addressSpaceOf("http://localhost:3013")).toBe("loopback");
    expect(addressSpaceOf("http://LOCALHOST:3013/")).toBe("loopback");
    expect(addressSpaceOf("https://api.swarm.localhost:1355")).toBe("loopback");
    expect(addressSpaceOf("http://127.0.0.1:3013")).toBe("loopback");
    expect(addressSpaceOf("http://127.8.9.10")).toBe("loopback");
    expect(addressSpaceOf("http://[::1]:3013")).toBe("loopback");
  });

  test("local: private, link-local, and CGNAT IPv4; ULA and link-local IPv6", () => {
    expect(addressSpaceOf("http://10.0.0.5:3013")).toBe("local");
    expect(addressSpaceOf("http://172.16.0.1")).toBe("local");
    expect(addressSpaceOf("http://172.31.255.255")).toBe("local");
    expect(addressSpaceOf("http://192.168.1.20:3013")).toBe("local");
    expect(addressSpaceOf("http://169.254.10.1")).toBe("local");
    expect(addressSpaceOf("http://100.101.102.103:3013")).toBe("local");
    expect(addressSpaceOf("http://[fd12:3456::1]:3013")).toBe("local");
    expect(addressSpaceOf("http://[fe80::1]")).toBe("local");
  });

  test("null: public hosts and IPs, names that need DNS, relative or invalid URLs", () => {
    expect(addressSpaceOf("https://silent-flowers-show.lt.desplega.ai")).toBeNull();
    expect(addressSpaceOf("http://8.8.8.8")).toBeNull();
    expect(addressSpaceOf("http://172.32.0.1")).toBeNull();
    expect(addressSpaceOf("http://100.128.0.1")).toBeNull();
    expect(addressSpaceOf("http://[2001:4860::8888]")).toBeNull();
    expect(addressSpaceOf("http://[fc::1]")).toBeNull();
    expect(addressSpaceOf("http://0.0.0.0:3013")).toBeNull();
    expect(addressSpaceOf("http://localhost.example.com")).toBeNull();
    expect(addressSpaceOf("http://printer.local")).toBeNull();
    expect(addressSpaceOf("/api/health")).toBeNull();
    expect(addressSpaceOf("")).toBeNull();
  });
});

describe("isLocalNetworkUrl", () => {
  test("adds .local mDNS names to the hosts addressSpaceOf knows", () => {
    expect(isLocalNetworkUrl("http://taras-mbp.local:3013")).toBe(true);
    expect(isLocalNetworkUrl("http://localhost:3013")).toBe(true);
    expect(isLocalNetworkUrl("https://app.agent-swarm.dev")).toBe(false);
  });
});

describe("withAddressSpace", () => {
  test("adds the hint only for a host with a known address space", () => {
    const init = { headers: { Authorization: "Bearer fake" } };
    expect(withAddressSpace("http://localhost:3013/health", init)).toEqual({
      ...init,
      targetAddressSpace: "loopback",
    });
    expect(withAddressSpace("http://192.168.1.20:3013/health", init)).toEqual({
      ...init,
      targetAddressSpace: "local",
    });
    expect(withAddressSpace("http://box.local:3013/health", init)).toBe(init);
    expect(withAddressSpace("https://swarm.example.com/health", init)).toBe(init);
    expect(withAddressSpace("/health", init)).toBe(init);
  });
});

describe("needsLocalNetworkPermission", () => {
  test("a secure public page calling a local API", () => {
    const hosted = "https://app.agent-swarm.dev/setup";
    expect(needsLocalNetworkPermission("http://localhost:3013", hosted)).toBe(true);
    expect(needsLocalNetworkPermission("http://192.168.1.20:3013", hosted)).toBe(true);
    expect(needsLocalNetworkPermission("http://box.local:3013", hosted)).toBe(true);
    expect(needsLocalNetworkPermission("https://x.lt.desplega.ai", hosted)).toBe(false);
  });

  test("a dashboard on this machine or an http page asks nothing", () => {
    expect(needsLocalNetworkPermission("http://localhost:3013", "http://localhost:5274/")).toBe(
      false,
    );
    expect(
      needsLocalNetworkPermission("http://localhost:3013", "https://ui.swarm.localhost:1355/"),
    ).toBe(false);
    expect(needsLocalNetworkPermission("http://localhost:3013", "http://swarm.example.com/")).toBe(
      false,
    );
  });
});

describe("isSafari", () => {
  test("tells Safari from Chromium and Firefox user agents", () => {
    const safari =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const chrome =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36";
    const edge = `${chrome} Edg/142.0.0.0`;
    const firefox =
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:149.0) Gecko/20100101 Firefox/149.0";
    const iosChrome =
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/142.0 Mobile/15E148 Safari/604.1";
    expect(isSafari(safari)).toBe(true);
    expect(isSafari(chrome)).toBe(false);
    expect(isSafari(edge)).toBe(false);
    expect(isSafari(firefox)).toBe(false);
    expect(isSafari(iosChrome)).toBe(false);
  });
});
