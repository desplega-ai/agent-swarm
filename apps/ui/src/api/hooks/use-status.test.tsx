import { describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import type { StatusResponse } from "../types";
import {
  applySavedIdentity,
  IDENTITY_SETTLE_MS,
  invalidateStatusQuery,
  STATUS_QUERY_KEY,
} from "./status-query";

describe("invalidateStatusQuery", () => {
  test("marks the shared dashboard status query stale after an integration save", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(STATUS_QUERY_KEY, { automations: [] });

    await invalidateStatusQuery(queryClient);

    expect(queryClient.getQueryState(STATUS_QUERY_KEY)?.isInvalidated).toBe(true);
  });
});

describe("applySavedIdentity", () => {
  const status = {
    identity: { name: "Acme", logo_url: null, brand_color: null },
  } as unknown as StatusResponse;
  const identity = (client: QueryClient) =>
    client.getQueryData<StatusResponse>(STATUS_QUERY_KEY)?.identity;

  test("a saved name or logo shows in the shell at once, then status refetches", async () => {
    const client = new QueryClient();
    client.setQueryData(STATUS_QUERY_KEY, status);
    applySavedIdentity(client, "SWARM_ORG_NAME", " Acme Labs ");
    applySavedIdentity(client, "SWARM_ORG_LOGO_URL", "https://cdn.acme.com/logo.svg");
    expect(identity(client)).toMatchObject({
      name: "Acme Labs",
      logo_url: "https://cdn.acme.com/logo.svg",
    });
    expect(client.getQueryState(STATUS_QUERY_KEY)?.isInvalidated).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, IDENTITY_SETTLE_MS + 50));
    expect(client.getQueryState(STATUS_QUERY_KEY)?.isInvalidated).toBe(true);
  });

  test("an emptied logo falls back to none; a removed key and unrelated keys patch nothing", () => {
    const client = new QueryClient();
    client.setQueryData(STATUS_QUERY_KEY, {
      ...status,
      identity: { ...status.identity, logo_url: "https://cdn.acme.com/logo.svg" },
    });
    applySavedIdentity(client, "SWARM_ORG_NAME", null);
    applySavedIdentity(client, "STEERING_ENABLED", "true");
    expect(identity(client)).toMatchObject({ name: "Acme" });
    applySavedIdentity(client, "SWARM_ORG_LOGO_URL", "");
    expect(identity(client)?.logo_url).toBeNull();
  });
});
