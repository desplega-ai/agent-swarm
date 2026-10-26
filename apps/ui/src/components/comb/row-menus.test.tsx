import { afterAll, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode, useLayoutEffect } from "react";

// A DOM for keyboard and menu checks; removed after this file so other files
// keep their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));

// The test runner cannot resolve ui's `@/` alias, so each aliased module in
// the graph maps to a real file or a stub.
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/agent-fs/client", () => require("../../lib/agent-fs/client"));
mock.module("@/lib/approval-shortcuts", () => require("../../lib/approval-shortcuts"));
mock.module("@/lib/comb/file-icons", () => require("../../lib/comb/file-icons"));
mock.module("@/lib/comb/folder-filter", () => require("../../lib/comb/folder-filter"));
mock.module("@/lib/comb/links", () => require("../../lib/comb/links"));
mock.module("@/lib/comb/paths", () => require("../../lib/comb/paths"));
mock.module("@/lib/comb/recent", () => require("../../lib/comb/recent"));
mock.module("@/lib/comb/search", () => require("../../lib/comb/search"));
mock.module("@/lib/comb/share", () => require("../../lib/comb/share"));
mock.module("@/lib/comb/tree", () => require("../../lib/comb/tree"));
mock.module("@/lib/json-render/use-page-shortcut", () =>
  require("../../lib/json-render/use-page-shortcut"),
);
mock.module("@/lib/relative-time", () => require("../../lib/relative-time"));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));
mock.module("@/hooks/use-debounced-value", () => require("../../hooks/use-debounced-value"));
for (const name of [
  "badge",
  "button",
  "command",
  "context-menu",
  "dialog",
  "dropdown-menu",
  "input",
  "kbd",
  "segmented-control",
  "skeleton",
  "spinner",
  "tooltip",
]) {
  mock.module(`@/components/ui/${name}`, () => require(`../ui/${name}`));
}
// happy-dom has no canvas to measure text with.
mock.module("@/components/ui/middle-truncation", () => ({
  MiddleTruncation: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
mock.module("@/components/comb/file-icon", () => require("./file-icon"));
mock.module("@/components/comb/file-menu", () => require("./file-menu"));
mock.module("@/components/comb/filter-input", () => require("./filter-input"));
mock.module("@/components/comb/use-url-draft", () => require("./use-url-draft"));
mock.module("@/components/comb/presence-avatars", () => ({ PresenceDots: () => null }));
mock.module("@/components/comb/file-actions", () => ({ downloadDriveFile: async () => {} }));
mock.module("@/components/comb/share-dialog", () => ({ ShareDialog: () => null }));
mock.module("@/components/comb/file-dialogs", () => ({
  DeleteDialog: () => null,
  NewEntryDialog: () => null,
  RenameDialog: () => null,
}));
mock.module("@/components/comb/use-author-label", () => ({
  useAuthorLabel: () => (author: string) => author,
}));
mock.module("@/components/comb/use-viewed-files", () => ({
  useViewedFiles: () => [{ path: "/a.md", at: Date.now() }],
}));
mock.module("@/contexts/agent-fs-context", () => ({
  useAgentFs: () => ({ liveUrl: null, features: new Set<string>() }),
}));

const ORG = "org-1";
const DRIVE = "drive-1";
const drive = { orgId: ORG, driveId: DRIVE };

const LISTINGS: Record<string, { name: string; type: "file" | "directory"; size: number }[]> = {
  "/": [
    { name: "docs", type: "directory", size: 0 },
    { name: "a.md", type: "file", size: 1 },
    { name: "b.md", type: "file", size: 1 },
  ],
};

// `useCombSearch` feeds both the tree filter (idle here) and the search dialog.
let searchState: Record<string, unknown> = { data: undefined, error: null, isFetching: false };
const refetch = mock(async () => ({}));
mock.module("@/api/hooks/use-agent-fs", () => ({
  useAgentFsAccess: () => ({ client: {} }),
  agentFsLsQuery: (_access: unknown, target: { path: string }) => ({
    queryKey: ["ls", target.path],
    queryFn: async () => ({ entries: LISTINGS[target.path] ?? [] }),
    initialData: { entries: LISTINGS[target.path] ?? [] },
    staleTime: Number.POSITIVE_INFINITY,
  }),
  useCombSearch: () => ({ ...searchState, refetch }),
  useAgentFsMediaUrl: () => null,
  useRecentChanges: () => ({ isPending: false, isError: false, data: [] }),
}));

const { pinIdFor } = await import("../../lib/comb/paths");
mock.module("@/api/hooks/use-comb-favorites", () => ({
  useCombFavorites: () => ({
    available: true,
    isPending: false,
    isToggling: false,
    error: null,
    ids: [pinIdFor({ ...drive, path: "/a.md" })],
    toggle: () => {},
  }),
  isCombFavorite: (favorites: { ids?: string[] }, target: { orgId: string; path: string }) =>
    favorites.ids?.includes(pinIdFor(target as Parameters<typeof pinIdFor>[0])) ?? false,
}));

const { createRoot } = await import("react-dom/client");
const { QueryClient, QueryClientProvider } = await import("@tanstack/react-query");
const { MemoryRouter } = await import("react-router-dom");
const { TooltipProvider } = await import("../ui/tooltip");
const { FileDialogsProvider } = await import("./file-menu");
const { TreeRail } = await import("./tree-rail");
const { FavoritesList, RecentlyViewedList } = await import("./recent-lists");
const { CombSearchButton } = await import("./search-dialog");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

async function render(node: ReactNode, url = "/") {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const client = new QueryClient();
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={[url]}>
          <TooltipProvider>
            <FileDialogsProvider current="/b.md">{node}</FileDialogsProvider>
          </TooltipProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    ),
  );
  return {
    container,
    unmount: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

async function press(element: Element, key: string) {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function menuButton(container: Element, name: string): HTMLButtonElement {
  const button = container.querySelector<HTMLButtonElement>(
    `button[aria-label="More actions for ${name}"]`,
  );
  if (!button) throw new Error(`no menu button for ${name}`);
  return button;
}

/** The open menu's item labels (Radix renders the menu in a portal on body). */
function menuLabels(): string[] {
  return [...document.querySelectorAll('[role="menuitem"]')].map(
    (item) => item.textContent?.trim() ?? "",
  );
}

/** Opens a row's menu from the keyboard: focus its button, press Enter. */
async function openWithKeyboard(container: Element, name: string): Promise<string[]> {
  const button = menuButton(container, name);
  expect(button.tabIndex).toBe(0);
  await act(async () => button.focus());
  await press(button, "Enter");
  return menuLabels();
}

const location = { ...drive, path: "/b.md", isFolder: false };

describe("tree row menus from the keyboard", () => {
  test("only the focused row's menu button is a Tab stop, and it follows the arrows", async () => {
    const { container, unmount } = await render(<TreeRail location={location} />);
    const tabbable = () =>
      [...container.querySelectorAll<HTMLButtonElement>('button[aria-label^="More actions for"]')]
        .filter((button) => button.tabIndex === 0)
        .map((button) => button.getAttribute("aria-label"));
    // The current file's row holds the tree's Tab stop, so its button is the one stop.
    expect(tabbable()).toEqual(["More actions for b.md"]);

    const current = container.querySelector('[role="treeitem"][data-path="/b.md"]');
    if (!current) throw new Error("no b.md row");
    await press(current, "ArrowUp");
    expect(document.activeElement?.getAttribute("data-path")).toBe("/a.md");
    expect(tabbable()).toEqual(["More actions for a.md"]);
    await unmount();
  });

  test("Enter on the focused row's button opens the full file menu", async () => {
    const { container, unmount } = await render(<TreeRail location={location} />);
    const labels = await openWithKeyboard(container, "b.md");
    expect(labels).toContain("Open");
    expect(labels).toContain("Copy path");
    expect(labels).toContain("Rename…");
    expect(labels).toContain("Delete…");
    await unmount();
  });
});

describe("Recent and Favorites rows use the tree's file menu", () => {
  async function treeMenu(path: string): Promise<string[]> {
    const { container, unmount } = await render(
      <TreeRail location={{ ...drive, path, isFolder: false }} />,
    );
    const labels = await openWithKeyboard(container, path.slice(1));
    await unmount();
    return labels;
  }

  test("a Favorites row's button opens the same menu as the tree row", async () => {
    const tree = await treeMenu("/a.md");
    expect(tree).toContain("Remove from favorites");
    const { container, unmount } = await render(<FavoritesList drive={drive} />);
    expect(await openWithKeyboard(container, "a.md")).toEqual(tree);
    await unmount();
  });

  test("a Recently viewed row opens the same menu, from its button and on right click", async () => {
    const tree = await treeMenu("/a.md");
    const { container, unmount } = await render(<RecentlyViewedList drive={drive} />);
    expect(await openWithKeyboard(container, "a.md")).toEqual(tree);
    await press(document.activeElement ?? document.body, "Escape");
    expect(menuLabels()).toEqual([]);

    const row = container.querySelector("li");
    if (!row) throw new Error("no row");
    await act(async () => {
      row.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));
    });
    expect(menuLabels()).toEqual(tree);
    await unmount();
  });
});

describe("search retry from the keyboard", () => {
  test("a failed search says Enter retries, and Enter in the box retries it", async () => {
    searchState = { data: undefined, error: new Error("Search backend down"), isFetching: false };
    refetch.mockClear();
    const { unmount } = await render(<CombSearchButton drive={drive} />, "/?q=plan");
    const alert = document.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Search backend down");
    expect(alert?.textContent).toContain("Press Enter to try again.");

    const input = document.querySelector('input[aria-label="Search query"]');
    if (!input) throw new Error("no search box");
    await press(input, "Enter");
    expect(refetch).toHaveBeenCalledTimes(1);
    await unmount();
    searchState = { data: undefined, error: null, isFetching: false };
  });
});
