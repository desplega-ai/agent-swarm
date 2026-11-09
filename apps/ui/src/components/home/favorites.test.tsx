import { expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import type { UserFavorite } from "../../api/types";

// `@/` resolves to the API's src/ under the test runner: map each ui module,
// and stub the row hooks with fixed reads.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/home-favorites", () => require("../../lib/home-favorites"));
mock.module("@/lib/session-groups", () => require("../../lib/session-groups"));
mock.module("@/components/shared/task-status-icon", () => require("../shared/task-status-icon"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/api/hooks/use-favorites", () => ({ useFavorites: () => ({}) }));
mock.module("@/api/hooks/use-pages", () => ({
  usePage: (id: string) =>
    id === "gone"
      ? { data: undefined, isError: true }
      : { data: { title: "Weekly digest", updatedAt: "2026-11-04T10:00:00Z" }, isError: false },
}));
mock.module("@/api/hooks/use-workflows", () => ({
  useWorkflow: () => ({
    data: { name: "Release flow", enabled: true, lastUpdatedAt: "2026-11-04T10:00:00Z" },
  }),
}));
mock.module("@/api/hooks/use-schedules", () => ({
  useScheduledTask: () => ({ data: { name: "Competitor scan", enabled: false } }),
}));
mock.module("@/api/hooks/use-session-tree", () => ({
  useSessionLabels: () => ({}),
  useSessionTree: () => ({
    data: {
      groups: [
        {
          key: "shared/po-qa/",
          total: 3,
          unread: 0,
          running: 1,
          needsYou: 0,
          lastActivityAt: "2026-11-04T10:00:00Z",
        },
      ],
    },
  }),
}));
mock.module("@/contexts/current-user-context", () => ({
  useCurrentUser: () => ({ userId: "u1" }),
}));

const { FavoritesView } = await import("./favorites");

const fav = (itemType: UserFavorite["itemType"], itemId: string): UserFavorite => ({
  id: `${itemType}:${itemId}`,
  itemType,
  itemId,
  createdAt: "2026-11-04T10:00:00Z",
  lastUpdatedAt: "2026-11-04T10:00:00Z",
});

const ok = { data: [], isLoading: false, isError: false, errorUpdateCount: 0, refetch: () => {} };

function render(favorites: UserFavorite[], initialLimit = Number.POSITIVE_INFINITY) {
  return renderToStaticMarkup(
    <MemoryRouter>
      <FavoritesView favorites={favorites} state={ok} initialLimit={initialLimit} />
    </MemoryRouter>,
  );
}

test("every favorite type renders a row that opens its entity", () => {
  const html = render([
    fav("key", "shared/po-qa/"),
    fav("page", "p1"),
    fav("workflow", "w1"),
    fav("schedule", "s1"),
    fav("agent-fs-path", "org/drive/shared/po-qa/"),
  ]);
  expect(html).toContain("po-qa");
  expect(html).toContain("1 running");
  expect(html).toContain('href="/sessions?view=shared%2Fpo-qa%2F"');
  expect(html).toContain("Weekly digest");
  expect(html).toContain('href="/pages/p1"');
  expect(html).toContain("Release flow");
  expect(html).toContain('href="/workflows/w1"');
  expect(html).toContain("Competitor scan");
  expect(html).toContain("Paused");
  expect(html).toContain('href="/schedules/s1"');
  expect(html).toContain("shared/po-qa/");
  expect(html).toContain('href="/file/~/org/drive/shared/po-qa/"');
  expect(html).toContain("Folder");
});

test("a star that outlived its item still lists, with a note", () => {
  const html = render([fav("key", "shared/deleted-group/"), fav("page", "gone")]);
  expect(html).toContain("deleted-group");
  expect(html).toContain("No sessions");
  expect(html).toContain("Page not found");
});

test("no favorites says how to star things", () => {
  expect(render([])).toContain("Nothing starred yet.");
});

test("the first 3 show, then Show all", () => {
  const html = render(
    [fav("page", "p1"), fav("workflow", "w1"), fav("schedule", "s1"), fav("key", "shared/po-qa/")],
    3,
  );
  expect(html).toContain('href="/pages/p1"');
  expect(html).not.toContain('href="/sessions?view=shared%2Fpo-qa%2F"');
  expect(html).toContain("Show all 4");
  expect(html).toContain("New use case");
});
