import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { invalidateStatusQuery, STATUS_QUERY_KEY } from "./status-query";

describe("invalidateStatusQuery", () => {
  test("marks the shared dashboard status query stale after an integration save", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(STATUS_QUERY_KEY, { automations: [] });

    await invalidateStatusQuery(queryClient);

    expect(queryClient.getQueryState(STATUS_QUERY_KEY)?.isInvalidated).toBe(true);
  });
});
