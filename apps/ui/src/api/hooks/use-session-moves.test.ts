import { expect, mock, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";

// Only the invalidation runs, so the client is never called.
mock.module("../client", () => ({ api: {} }));
mock.module("sonner", () => ({ toast: { error: () => {} } }));
// The real module imports `@/` aliases, which do not resolve under bun test.
const { SESSION_TREE_KEY } = await import("./session-query-keys");
mock.module("./use-session-tree", () => ({ SESSION_TREE_KEY }));

const { invalidateAfterMove } = await import("./use-session-moves");

test("a move refreshes the tree, the lists, the session detail and the key stars", () => {
  const queryClient = new QueryClient();
  const keys = [
    SESSION_TREE_KEY,
    ["sessions", "list"],
    ["session", "root-1"],
    ["favorites", "key", undefined],
    ["favorites", "workflow", undefined],
  ];
  for (const key of keys) queryClient.setQueryData(key, {});
  invalidateAfterMove(queryClient);
  const stale = keys.map((key) => queryClient.getQueryState(key)?.isInvalidated);
  expect(stale).toEqual([true, true, true, true, false]);
});
