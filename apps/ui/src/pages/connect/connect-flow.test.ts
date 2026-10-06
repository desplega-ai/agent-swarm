import { describe, expect, test } from "bun:test";
import {
  buildConnectorRedirect,
  connectionsForCustomReturnTo,
  defaultConnectorLabel,
  parseClient,
  resolveUserStep,
  selectConnectionStep,
  validateReturnTo,
} from "./connect-flow";

describe("validateReturnTo", () => {
  test("accepts the built-in connector origins", () => {
    for (const raw of [
      "https://mcp.agent-swarm.dev/connections",
      "https://mcp-preview.agent-swarm.dev/connections?x=1",
    ]) {
      expect(validateReturnTo(raw)?.toString()).toBe(new URL(raw).toString());
    }
  });

  test("rejects missing, malformed, unlisted and look-alike origins", () => {
    for (const raw of [
      null,
      "",
      "not a url",
      "javascript:alert(1)",
      "http://mcp.agent-swarm.dev/connections",
      "https://evil.example.com/connections",
      "https://mcp.agent-swarm.dev.evil.com/connections",
      "https://evil.com@mcp.agent-swarm.dev/connections",
      "https://user:pass@mcp.agent-swarm.dev/connections",
    ]) {
      expect(validateReturnTo(raw)).toBeNull();
    }
  });

  test("accepts an https CONNECTOR_CONNECT_URL origin reported by discovery", () => {
    const raw = "https://connector.example.com/connect";
    expect(validateReturnTo(raw)).toBeNull();
    expect(
      validateReturnTo(raw, { extraOrigins: ["https://connector.example.com/other"] }),
    ).not.toBeNull();
    expect(
      validateReturnTo("http://connector.example.com/connect", {
        extraOrigins: ["http://connector.example.com/connect"],
      }),
    ).toBeNull();
  });

  test("accepts http://localhost on any port only when allowed", () => {
    const raw = "http://localhost:3000/connections";
    expect(validateReturnTo(raw)).toBeNull();
    expect(validateReturnTo(raw, { allowLocalhost: true })?.toString()).toBe(raw);
    expect(validateReturnTo("http://127.0.0.1:3000/x", { allowLocalhost: true })).toBeNull();
  });
});

describe("connectionsForCustomReturnTo", () => {
  test("binds a custom destination to the swarms that report it", () => {
    const trusted = { id: "trusted" };
    const hostile = { id: "hostile" };
    const discovered = [
      { connection: trusted, connectUrl: "https://mcp.agent-swarm.dev/connections" },
      { connection: hostile, connectUrl: "https://attacker.example.com/grab" },
    ];
    expect(
      connectionsForCustomReturnTo("https://attacker.example.com/grab?x=1", discovered),
    ).toEqual([hostile]);
    expect(connectionsForCustomReturnTo("https://other.example.com/connect", discovered)).toEqual(
      [],
    );
    expect(
      connectionsForCustomReturnTo("https://attacker.example.com/grab", [
        { connection: trusted, connectUrl: null },
      ]),
    ).toEqual([]);
  });
});

describe("buildConnectorRedirect", () => {
  const connectUrl =
    "https://mcp.agent-swarm.dev/connections?swarm=https%3A%2F%2Fswarm.example.com&code=abc_DEF-123";

  test("replaces the base with return_to, keeps swarm and code, appends client", () => {
    const target = buildConnectorRedirect(
      new URL("http://localhost:3000/connections"),
      connectUrl,
      "chatgpt",
    );
    expect(target).toBe(
      "http://localhost:3000/connections?swarm=https%3A%2F%2Fswarm.example.com&code=abc_DEF-123&client=chatgpt",
    );
  });

  test("keeps return_to's own query and fragment and overrides a stale client", () => {
    const target = new URL(
      buildConnectorRedirect(
        new URL("https://mcp-preview.agent-swarm.dev/connections?step=2&client=codex#done"),
        connectUrl,
        "claude",
      ),
    );
    expect(target.origin).toBe("https://mcp-preview.agent-swarm.dev");
    expect(target.searchParams.get("step")).toBe("2");
    expect(target.searchParams.get("swarm")).toBe("https://swarm.example.com");
    expect(target.searchParams.get("code")).toBe("abc_DEF-123");
    expect(target.searchParams.getAll("client")).toEqual(["claude"]);
    expect(target.hash).toBe("#done");
  });

  test("refuses a connect URL without a code", () => {
    expect(() =>
      buildConnectorRedirect(
        new URL("https://mcp.agent-swarm.dev/connections"),
        "https://mcp.agent-swarm.dev/connections?swarm=x",
        "chatgpt",
      ),
    ).toThrow();
  });
});

describe("selectConnectionStep", () => {
  const a = { id: "a" };
  const b = { id: "b" };

  test("no connections asks the user to add one", () => {
    expect(selectConnectionStep([])).toEqual({ kind: "none" });
  });

  test("one connection is used directly", () => {
    expect(selectConnectionStep([a])).toEqual({ kind: "selected", connection: a });
  });

  test("several connections need a pick unless the hint matches one", () => {
    expect(selectConnectionStep([a, b])).toEqual({ kind: "pick", connections: [a, b] });
    expect(selectConnectionStep([a, b], "b")).toEqual({ kind: "selected", connection: b });
    expect(selectConnectionStep([a, b], "missing")).toEqual({
      kind: "pick",
      connections: [a, b],
    });
  });
});

describe("resolveUserStep", () => {
  test("skips the picker when whoami resolves a user", () => {
    const user = { id: "u1" };
    expect(resolveUserStep({ kind: "user", user })).toEqual({ kind: "self", user });
  });

  test("asks for a pick for an operator key or an older server", () => {
    expect(resolveUserStep({ kind: "operator", user: null })).toEqual({ kind: "pick" });
    expect(resolveUserStep(null)).toEqual({ kind: "pick" });
  });
});

describe("parseClient", () => {
  test("defaults unknown clients to chatgpt and names the default label", () => {
    expect(parseClient("cursor")).toBe("cursor");
    expect(parseClient("other")).toBe("chatgpt");
    expect(parseClient(null)).toBe("chatgpt");
    expect(defaultConnectorLabel("claude")).toBe("Claude connector");
  });
});
