import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { addConnection, getActiveConnection, getConfig, getConnections } from "./config";

GlobalRegistrator.register();
afterAll(() => GlobalRegistrator.unregister());
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});

const connection = { id: "saved", name: "Saved", apiUrl: "http://localhost:3013", apiKey: "" };

describe("saved connection configuration", () => {
  test.each([
    "[]",
    "null",
    "{}",
    "true",
    "42",
    '"config"',
    '{"connections":null,"activeId":null}',
    '{"connections":{},"activeId":null}',
    '{"connections":[]}',
    '{"connections":[],"activeId":42}',
    '{"connections":[null],"activeId":null}',
    '{"connections":[{}],"activeId":null}',
    ...["id", "name", "apiUrl", "apiKey"].flatMap((field) => {
      const missing: Record<string, unknown> = { ...connection };
      delete missing[field];
      return [missing, { ...connection, [field]: 42 }].map((entry) =>
        JSON.stringify({ connections: [entry], activeId: "saved" }),
      );
    }),
  ])("recovers from malformed-but-valid stored JSON: %s", (stored) => {
    localStorage.setItem("agent-swarm-connections", stored);
    expect(getConnections()).toEqual([]);
    expect(getActiveConnection()).toBeNull();
    expect(getConfig()).toEqual({ apiUrl: "http://localhost:3013", apiKey: "" });

    const added = addConnection({ name: "New", apiUrl: "http://localhost:4013", apiKey: "" });
    expect(getConnections()).toEqual([added]);
    expect(getActiveConnection()).toEqual(added);
  });

  test.each([
    "saved",
    null,
    "orphaned",
  ])("preserves valid connections with activeId %s", (activeId) => {
    localStorage.setItem(
      "agent-swarm-connections",
      JSON.stringify({ connections: [connection], activeId }),
    );
    expect(getConnections()).toEqual([connection]);
    expect(getActiveConnection()).toEqual(connection);
  });

  test("accepts a valid empty configuration", () => {
    localStorage.setItem("agent-swarm-connections", '{"connections":[],"activeId":null}');
    expect(getConnections()).toEqual([]);
    expect(getActiveConnection()).toBeNull();
  });

  test("still migrates legacy configuration when no connection configuration exists", () => {
    localStorage.setItem(
      "agent-swarm-config",
      JSON.stringify({ apiUrl: "http://localhost:4013", apiKey: "legacy-key" }),
    );
    expect(getActiveConnection()).toMatchObject({
      name: "default",
      apiUrl: "http://localhost:4013",
      apiKey: "legacy-key",
    });
    expect(localStorage.getItem("agent-swarm-config")).toBeNull();
  });
});
