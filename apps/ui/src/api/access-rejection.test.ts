import { describe, expect, test } from "bun:test";
import {
  accessId,
  isAccessEnded,
  isKeyRejection,
  noteUnauthorized,
  setAccessEnded,
  subscribeEndedAccess,
  subscribeKeyRejection,
} from "./access-rejection";

const ORIGIN = "http://localhost:5274";
const KEY = "aswt_0123456789abcd"; // gitleaks:allow (fake test key)
const connection = { apiUrl: "https://swarm.example.com", apiKey: KEY };
const bearer = { Authorization: `Bearer ${KEY}` };

describe("isKeyRejection", () => {
  test("a request to the API with the saved key", () => {
    expect(isKeyRejection("https://swarm.example.com/api/tasks", bearer, connection, ORIGIN)).toBe(
      true,
    );
  });

  test("an API under a path prefix", () => {
    const prefixed = { ...connection, apiUrl: "https://example.com/swarm/" };
    expect(isKeyRejection("https://example.com/swarm/api/apps", bearer, prefixed, ORIGIN)).toBe(
      true,
    );
    expect(isKeyRejection("https://example.com/other/api/apps", bearer, prefixed, ORIGIN)).toBe(
      false,
    );
    expect(isKeyRejection("https://example.com/swarmy/api", bearer, prefixed, ORIGIN)).toBe(false);
  });

  test("a relative URL is the dev proxy to the API", () => {
    expect(isKeyRejection("/api/agents", bearer, connection, ORIGIN)).toBe(true);
  });

  test("not the agent-fs proxy: agent-fs answers those", () => {
    expect(
      isKeyRejection("https://swarm.example.com/agentfs/orgs/1/files", bearer, connection, ORIGIN),
    ).toBe(false);
    expect(isKeyRejection("/agentfs/health", bearer, connection, ORIGIN)).toBe(false);
  });

  test("not another host", () => {
    expect(isKeyRejection("https://telemetry.example.com/v1/x", bearer, connection, ORIGIN)).toBe(
      false,
    );
  });

  test("not without the saved key", () => {
    const url = "https://swarm.example.com/api/tasks";
    expect(isKeyRejection(url, undefined, connection, ORIGIN)).toBe(false);
    expect(isKeyRejection(url, { Authorization: "Bearer other" }, connection, ORIGIN)).toBe(false);
    expect(isKeyRejection(url, bearer, { ...connection, apiKey: "" }, ORIGIN)).toBe(false);
  });

  test("reads Headers objects too", () => {
    expect(
      isKeyRejection(
        "/api/tasks",
        new Headers({ authorization: `Bearer ${KEY}` }),
        connection,
        ORIGIN,
      ),
    ).toBe(true);
  });
});

describe("noteUnauthorized", () => {
  test("notifies with the access id, never the key", () => {
    const seen: string[] = [];
    const stop = subscribeKeyRejection((id) => seen.push(id));
    noteUnauthorized("https://swarm.example.com/api/tasks", bearer, connection, ORIGIN);
    noteUnauthorized("https://swarm.example.com/agentfs/x", bearer, connection, ORIGIN);
    stop();
    noteUnauthorized("https://swarm.example.com/api/tasks", bearer, connection, ORIGIN);
    expect(seen).toEqual(["https://swarm.example.com|abcd"]);
    expect(seen[0]).not.toContain(KEY);
  });
});

describe("ended accesses", () => {
  test("are kept per access id and notify on change only", () => {
    const id = accessId(connection);
    const other = accessId({ ...connection, apiKey: "aswt_zzzz9999" });
    let changes = 0;
    const stop = subscribeEndedAccess(() => {
      changes += 1;
    });
    setAccessEnded(id, true);
    setAccessEnded(id, true);
    expect(isAccessEnded(id)).toBe(true);
    expect(isAccessEnded(other)).toBe(false);
    setAccessEnded(id, false);
    stop();
    expect(isAccessEnded(id)).toBe(false);
    expect(changes).toBe(2);
  });
});
