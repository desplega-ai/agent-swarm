import { describe, expect, test } from "bun:test";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { paletteSearchKey } from "../lib/command-palette/identity";
import { MAX_PERSISTED_SESSION_TASKS, shouldPersistQuery } from "./query-persistence";

const connection = { apiUrl: "http://swarm.test", apiKey: "operator-key" };

describe("shouldPersistQuery", () => {
  test("agent-fs and Cmd+K search queries are not dehydrated, other successful queries are", () => {
    const client = new QueryClient();
    client.setQueryData(["agent-fs", "http://fs.test", "user-1", "org-1", "drive-1", "ls", "/"], {
      entries: [],
    });
    client.setQueryData(["agent-fs", "http://fs.test", "user-1", null, null, "me"], {
      userId: "user-1",
    });
    client.setQueryData(paletteSearchKey(connection, "tasks", "deploy", 8), []);
    client.setQueryData(["tasks"], []);
    client.setQueryData(["status"], { ok: true });

    const keys = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map(
      (query) => query.queryKey[0],
    );
    expect(keys.sort()).toEqual(["status", "tasks"]);
    client.clear();
  });

  test("session logs and long session details stay in memory, short sessions persist", () => {
    const client = new QueryClient();
    const tasks = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}` }));
    client.setQueryData(["task", "t1", "session-logs"], [{ id: "log" }]);
    client.setQueryData(["task", "t1"], { id: "t1" });
    client.setQueryData(["session", "short", null], { chain: tasks(MAX_PERSISTED_SESSION_TASKS) });
    client.setQueryData(["session", "long", null], {
      chain: tasks(MAX_PERSISTED_SESSION_TASKS + 1),
    });

    const keys = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map(
      (query) => query.queryKey.slice(0, 3).join("/"),
    );
    expect(keys.sort()).toEqual(["session/short/", "task/t1"]);
    client.clear();
  });
});
