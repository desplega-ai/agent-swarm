import { describe, expect, test } from "bun:test";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { shouldPersistQuery } from "./query-persistence";

describe("shouldPersistQuery", () => {
  test("agent-fs queries are not dehydrated, other successful queries are", () => {
    const client = new QueryClient();
    client.setQueryData(["agent-fs", "http://fs.test", "user-1", "org-1", "drive-1", "ls", "/"], {
      entries: [],
    });
    client.setQueryData(["agent-fs", "http://fs.test", "user-1", null, null, "me"], {
      userId: "user-1",
    });
    client.setQueryData(["tasks"], []);
    client.setQueryData(["status"], { ok: true });

    const keys = dehydrate(client, { shouldDehydrateQuery: shouldPersistQuery }).queries.map(
      (query) => query.queryKey[0],
    );
    expect(keys.sort()).toEqual(["status", "tasks"]);
    client.clear();
  });
});
