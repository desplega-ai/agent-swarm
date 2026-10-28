import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { setSessionsShow } from "../../lib/sessions-show";
import { sidebarListParams } from "../../lib/sessions-v2";
import type { SessionListItem, SessionsListResponse, SessionTreeResponse } from "../types";
import {
  sessionDetailKey,
  sessionListKey,
  sessionListParams,
  sessionTreeKey,
} from "./session-query-keys";
import {
  cancelForTriage,
  patchTriageCaches,
  refreshAfterTriage,
  rollBackTriageCaches,
} from "./session-triage-cache";

const USER = "user-1";

function row(id: string, lastActivityAt: string): SessionListItem {
  return {
    root: { id },
    lastActivityAt,
    readState: "unread",
    snoozeUntil: null,
  } as unknown as SessionListItem;
}

function page(...sessions: SessionListItem[]): SessionsListResponse {
  return { sessions, total: sessions.length, limit: 50, offset: 0 };
}

function tree(done: number): SessionTreeResponse {
  return {
    groups: [],
    inbox: { total: 1, unread: 1 },
    later: { total: 0, unread: 0 },
    done: { total: done, unread: 0 },
    noGroup: { total: 0, unread: 0 },
  } as unknown as SessionTreeResponse;
}

/** The key of a sidebar section list in one Mine / All view. */
function sectionKey(section: string, show: "mine" | "all") {
  return sessionListKey(USER, sessionListParams(sidebarListParams(section), show));
}

const ids = (client: QueryClient, key: readonly unknown[]) =>
  client.getQueryData<SessionsListResponse>(key)?.sessions.map((r) => r.root.id);
const doneTotal = (client: QueryClient, show: "mine" | "all") =>
  client.getQueryData<SessionTreeResponse>(sessionTreeKey(USER, show))?.done.total;

afterEach(() => setSessionsShow("mine"));

describe("patchTriageCaches", () => {
  // B1: the arrival wrote the tree under its old two-part key, so the
  // show-aware tree the sidebar reads kept Done at zero and the moved row
  // stayed hidden under a collapsed, empty Done until the refetch.
  test("a row moved into an empty Done raises the show-aware tree count, and rollback lowers it", () => {
    setSessionsShow("mine");
    const client = new QueryClient();
    client.setQueryData(sessionTreeKey(USER, "mine"), tree(0));
    client.setQueryData(sectionKey("inbox", "mine"), page(row("a", "2026-10-22T10:00:00.000Z")));

    const context = patchTriageCaches(client, USER, new Set(["a"]), { kind: "done" });

    expect(doneTotal(client, "mine")).toBe(1);
    expect(ids(client, sectionKey("done", "mine"))).toEqual(["a"]);
    expect(ids(client, sectionKey("inbox", "mine"))).toEqual([]);

    rollBackTriageCaches(client, context);

    expect(doneTotal(client, "mine")).toBe(0);
    expect(ids(client, sectionKey("done", "mine"))).toEqual([]);
    expect(ids(client, sectionKey("inbox", "mine"))).toEqual(["a"]);
  });

  // B2: a workflow session cached by the All view was copied into Mine's
  // Done list when its pane was marked Done in Mine.
  test("a row cached only by the All view never arrives in Mine's Done list", () => {
    setSessionsShow("all");
    const client = new QueryClient();
    client.setQueryData(sectionKey("inbox", "all"), page(row("wf", "2026-10-22T11:00:00.000Z")));
    setSessionsShow("mine");
    client.setQueryData(sessionTreeKey(USER, "mine"), tree(1));
    client.setQueryData(sessionTreeKey(USER, "all"), tree(1));
    const mineDone = page({ ...row("d", "2026-10-22T09:00:00.000Z"), readState: "done" });
    client.setQueryData(sectionKey("done", "mine"), mineDone);

    const context = patchTriageCaches(client, USER, new Set(["wf"]), { kind: "done" });

    expect(ids(client, sectionKey("done", "mine"))).toEqual(["d"]);
    expect(doneTotal(client, "mine")).toBe(1);
    // All still shows it moving, in its own count.
    expect(doneTotal(client, "all")).toBe(2);

    rollBackTriageCaches(client, context);

    expect(doneTotal(client, "all")).toBe(1);
    expect(ids(client, sectionKey("done", "mine"))).toEqual(["d"]);
  });

  test("a row from a Mine page also arrives in All's cached Done list", () => {
    setSessionsShow("mine");
    const client = new QueryClient();
    client.setQueryData(sectionKey("inbox", "mine"), page(row("a", "2026-10-22T10:00:00.000Z")));
    client.setQueryData(sectionKey("done", "all"), page());

    patchTriageCaches(client, USER, new Set(["a"]), { kind: "done" });

    expect(ids(client, sectionKey("done", "mine"))).toEqual(["a"]);
    expect(ids(client, sectionKey("done", "all"))).toEqual(["a"]);
  });
});

describe("refreshAfterTriage", () => {
  const invalidated = (client: QueryClient, key: readonly unknown[]) =>
    client.getQueryState(key)?.isInvalidated ?? false;

  function seeded() {
    const client = new QueryClient();
    client.setQueryData(sessionTreeKey(USER, "mine"), tree(0));
    client.setQueryData(sectionKey("inbox", "mine"), page(row("a", "2026-10-22T10:00:00.000Z")));
    client.setQueryData(sectionKey("done", "mine"), page(row("b", "2026-10-22T09:00:00.000Z")));
    return client;
  }

  // Opening a session used to refetch the tree and every list after the
  // mark-read write, each one a slow chain walk on the server.
  test("a read refetches the tree and only the lists that held the row", () => {
    const client = seeded();
    const context = patchTriageCaches(client, USER, new Set(["a"]), { kind: "read" });
    refreshAfterTriage(client, { kind: "read" }, context, false);

    expect(invalidated(client, sessionTreeKey(USER, "mine"))).toBe(true);
    expect(invalidated(client, sectionKey("inbox", "mine"))).toBe(true);
    expect(invalidated(client, sectionKey("done", "mine"))).toBe(false);
  });

  // A mixed selection marked read took its Done row back to the Inbox, but
  // only the lists that held a row refetched, so the row's group never
  // showed it until the next poll.
  for (const parked of ["done", "later"] as const) {
    test(`a read that takes a ${parked} row back to the Inbox refetches every list`, () => {
      const client = seeded();
      const group = sectionKey("grp", "mine");
      client.setQueryData(group, page(row("c", "2026-10-22T08:00:00.000Z")));
      const from = sectionKey(parked, "mine");
      client.setQueryData(
        from,
        page({ ...row("b", "2026-10-22T09:00:00.000Z"), readState: parked }),
      );

      const context = patchTriageCaches(client, USER, new Set(["a", "b"]), { kind: "read" });
      expect(context.leftLaterOrDone).toBe(true);
      refreshAfterTriage(client, { kind: "read" }, context, false);

      expect(invalidated(client, group)).toBe(true);
      expect(invalidated(client, sectionKey("inbox", "mine"))).toBe(true);
      expect(invalidated(client, from)).toBe(true);
    });
  }

  test("a read of a Done session known only from its open pane refetches every list", () => {
    const client = seeded();
    const group = sectionKey("grp", "mine");
    client.setQueryData(group, page(row("c", "2026-10-22T08:00:00.000Z")));
    client.setQueryData(sessionDetailKey("z", USER), { readState: "done" });

    const context = patchTriageCaches(client, USER, new Set(["z"]), { kind: "read" });
    refreshAfterTriage(client, { kind: "read" }, context, false);

    expect(invalidated(client, group)).toBe(true);
  });

  // Opening a session from a link marks it read while the Inbox's first
  // load is in flight. The write cancels that load, which leaves the list
  // with no rows, so the refetch after the write must cover it.
  test("a read refetches the list fetches its cancel cut short", async () => {
    const client = new QueryClient();
    const inbox = sectionKey("inbox", "mine");
    client
      .fetchQuery({ queryKey: inbox, queryFn: () => new Promise<never>(() => {}) })
      .catch(() => {});
    const interrupted = await cancelForTriage(client, USER, new Set(["a"]));
    expect(client.getQueryData(inbox)).toBeUndefined();

    const context = patchTriageCaches(client, USER, new Set(["a"]), { kind: "read" });
    refreshAfterTriage(client, { kind: "read" }, { ...context, interrupted }, false);
    expect(invalidated(client, inbox)).toBe(true);
  });

  test("a write in flight defers the refetch, and any non-read write refetches every list", () => {
    const client = seeded();
    const read = patchTriageCaches(client, USER, new Set(["a"]), { kind: "read" });
    refreshAfterTriage(client, { kind: "read" }, read, true);
    expect(invalidated(client, sessionTreeKey(USER, "mine"))).toBe(false);
    expect(invalidated(client, sectionKey("inbox", "mine"))).toBe(false);

    const done = patchTriageCaches(client, USER, new Set(["b"]), { kind: "inbox" });
    refreshAfterTriage(client, { kind: "inbox" }, done, false);
    expect(invalidated(client, sessionTreeKey(USER, "mine"))).toBe(true);
    expect(invalidated(client, sectionKey("inbox", "mine"))).toBe(true);
    expect(invalidated(client, sectionKey("done", "mine"))).toBe(true);
  });
});
