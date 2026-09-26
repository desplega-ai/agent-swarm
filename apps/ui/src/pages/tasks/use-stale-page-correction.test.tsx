import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createContext, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import createReconciler from "react-reconciler";
import { ConcurrentRoot, DefaultEventPriority, NoEventPriority } from "react-reconciler/constants";
import { MemoryRouter, useLocation, useNavigationType, useSearchParams } from "react-router-dom";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this graph maps to its real file. The API client is
// real too; only its base URL and `fetch` are fixtures.
mock.module("@/components/shared/list-pager", () => import("../../components/shared/list-pager"));
mock.module("@/components/ui/button", () => import("../../components/ui/button"));
mock.module("@/components/ui/select", () => import("../../components/ui/select"));
mock.module("@/lib/utils", () => import("../../lib/utils"));
mock.module("@/lib/config", () => ({
  getConfig: () => ({ apiUrl: "https://api.example.test", apiKey: "" }),
}));

const { ListPager } = await import("../../components/shared/list-pager");
const { useTasks } = await import("../../api/hooks/use-tasks");
const { useStalePageCorrection } = await import("./use-stale-page-correction");

// No DOM in this runner, so a minimal renderer runs the effects. The harness
// renders no host elements, so only the root-level host methods are reached.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let updatePriority = NoEventPriority;
let uncaught: unknown = null;
const noHost = () => {
  throw new Error("the harness renders no host elements");
};
const renderer = createReconciler({
  getRootHostContext: () => ({}),
  getChildHostContext: (parent: object) => parent,
  prepareForCommit: () => null,
  resetAfterCommit: () => {},
  preparePortalMount: () => {},
  clearContainer: () => {},
  shouldSetTextContent: () => false,
  createInstance: noHost,
  createTextInstance: noHost,
  appendInitialChild: noHost,
  appendChildToContainer: noHost,
  insertInContainerBefore: noHost,
  removeChildFromContainer: () => {},
  finalizeInitialChildren: () => false,
  getPublicInstance: (instance: unknown) => instance,
  detachDeletedInstance: () => {},
  isPrimaryRenderer: true,
  supportsMutation: true,
  supportsPersistence: false,
  supportsHydration: false,
  scheduleTimeout: setTimeout,
  cancelTimeout: clearTimeout,
  noTimeout: -1,
  setCurrentUpdatePriority: (priority: number) => {
    updatePriority = priority;
  },
  getCurrentUpdatePriority: () => updatePriority,
  resolveUpdatePriority: () =>
    updatePriority !== NoEventPriority ? updatePriority : DefaultEventPriority,
  maySuspendCommit: () => false,
  NotPendingTransition: undefined,
  HostTransitionContext: createContext(null),
  resetFormInstance: () => {},
  requestPostPaintCallback: () => {},
  shouldAttemptEagerTransition: () => false,
  trackSchedulerEvent: () => {},
  resolveEventType: () => null,
  resolveEventTimeStamp: () => -1.1,
  preloadInstance: () => true,
  startSuspendingCommit: () => {},
  suspendInstance: () => {},
  waitForCommitToBeReady: () => null,
});

type View = {
  search: string;
  navigationType: string;
  loading: boolean;
  rows: string[];
  pager: { page: number; pageSize: number; total: number };
};

/**
 * The Tasks page's paging path, with its real pieces: `?page=` parsed the same
 * way, the real `useTasks` query at `page * pageSize`, and the production
 * correction hook. Records what the page would render on every pass.
 */
function TasksPaging({ pageSize, views }: { pageSize: number; views: View[] }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const location = useLocation();
  const navigationType = useNavigationType();
  const page = searchParams.has("page") ? Number(searchParams.get("page")) : 0;
  const { data: tasksData, isLoading } = useTasks({
    search: searchParams.get("search") ?? undefined,
    limit: pageSize,
    offset: page * pageSize,
  });
  const { page: listPage, stale: pageStale } = useStalePageCorrection(
    page,
    pageSize,
    tasksData?.total,
    setSearchParams,
  );
  const loading = isLoading || pageStale;
  views.push({
    search: location.search,
    navigationType,
    loading,
    rows: loading ? [] : (tasksData?.tasks ?? []).map((task) => task.id),
    pager: { page: listPage, pageSize, total: tasksData?.total ?? 0 },
  });
  return null;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

/**
 * Opens `/tasks<search>` against a server holding `rowCount` tasks and waits
 * for the list to stop loading (or gives up, so a regression shows up as
 * failed assertions rather than a timeout). Returns the final view and every
 * offset the page asked the API for.
 */
async function openTasks(search: string, pageSize: number, rowCount: number) {
  const offsets: number[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const params = new URL(String(input)).searchParams;
    const offset = Number(params.get("offset"));
    const limit = Number(params.get("limit"));
    offsets.push(offset);
    const ids = Array.from({ length: Math.max(0, Math.min(limit, rowCount - offset)) }, (_, i) => ({
      id: `task-${offset + i}`,
    }));
    return new Response(JSON.stringify({ tasks: ids, total: rowCount }), {
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const views: View[] = [];
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  uncaught = null;
  const root = renderer.createContainer(
    {},
    ConcurrentRoot,
    null,
    false,
    null,
    "",
    (error: unknown) => {
      uncaught = error;
    },
    () => {},
    () => {},
    () => {},
    null,
  );
  const tree: ReactNode = (
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[`/tasks${search}`]}>
        <TasksPaging pageSize={pageSize} views={views} />
      </MemoryRouter>
    </QueryClientProvider>
  );
  await act(async () => {
    renderer.updateContainer(tree, root, null, null);
  });
  for (let tick = 0; tick < 50; tick++) {
    const last = views[views.length - 1];
    if (last && !last.loading && queryClient.isFetching() === 0) break;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2)));
  }
  await act(async () => {
    renderer.updateContainer(null, root, null, null);
  });
  queryClient.clear();
  if (uncaught) throw uncaught;
  const view = views[views.length - 1] as View;
  return { view, views, offsets, ...pagerState(view.pager) };
}

type Node = { props?: Record<string, unknown> } | Node[] | null | undefined;

/** The range text, and the page each arrow goes to (null when disabled). */
function pagerState(pager: View["pager"]) {
  let target: number | null = null;
  const props = {
    ...pager,
    pageSizeOptions: [pager.pageSize],
    onPageChange: (next: number) => {
      target = next;
    },
    onPageSizeChange: () => {},
    emptyLabel: "0 tasks",
  };
  const html = renderToStaticMarkup(<ListPager {...props} />);
  const arrow = (label: string): number | null => {
    const stack: Node[] = [ListPager(props) as Node];
    while (stack.length > 0) {
      const node = stack.pop();
      if (Array.isArray(node)) stack.push(...node);
      else if (node?.props) {
        if (node.props["aria-label"] === label) {
          if (node.props.disabled) return null;
          target = null;
          (node.props.onClick as () => void)();
          return target;
        }
        stack.push(node.props.children as Node);
      }
    }
    throw new Error(`no ${label} button`);
  };
  return {
    range: html.match(/\d+–\d+ of \d+|0 tasks/)?.[0] ?? null,
    pageLabel: html.match(/Page \d+ of \d+/)?.[0] ?? null,
    previous: arrow("Previous page"),
    next: arrow("Next page"),
  };
}

describe("Tasks page with a stale ?page=", () => {
  test("one-page result: the URL drops ?page=, page 0 is fetched and its row shown", async () => {
    // /tasks?page=1&search=<id> with a single match.
    const tasks = await openTasks("?page=1&search=abc", 20, 1);
    expect(tasks.view.search).toBe("?search=abc");
    expect(tasks.view.navigationType).toBe("REPLACE");
    expect(tasks.offsets).toEqual([20, 0]);
    expect(tasks.view.rows).toEqual(["task-0"]);
    expect(tasks.range).toBe("1–1 of 1");
    expect(tasks.pageLabel).toBe("Page 1 of 1");
    expect(tasks.previous).toBeNull();
    expect(tasks.next).toBeNull();
    // The stale page's empty response is never shown as the result.
    expect(tasks.views.some((v) => !v.loading && v.rows.length === 0)).toBe(false);
  });

  test("far past the end: lands on the real last page and fetches it", async () => {
    // /tasks?page=700 with 28,387 tasks at 100 per page.
    const tasks = await openTasks("?page=700", 100, 28387);
    expect(tasks.view.search).toBe("?page=283");
    expect(tasks.view.navigationType).toBe("REPLACE");
    expect(tasks.offsets).toEqual([70000, 28300]);
    expect(tasks.view.rows).toHaveLength(87);
    expect(tasks.view.rows[0]).toBe("task-28300");
    expect(tasks.view.rows[86]).toBe("task-28386");
    expect(tasks.range).toBe("28301–28387 of 28387");
    expect(tasks.pageLabel).toBe("Page 284 of 284");
    expect(tasks.previous).toBe(282);
    expect(tasks.next).toBeNull();
  });

  test("an in-range deep link is kept through the load and fetched once", async () => {
    const tasks = await openTasks("?page=1", 20, 35);
    expect(tasks.views[0]?.pager.page).toBe(1);
    expect(tasks.view.search).toBe("?page=1");
    expect(tasks.view.navigationType).toBe("POP");
    expect(tasks.offsets).toEqual([20]);
    expect(tasks.view.rows[0]).toBe("task-20");
    expect(tasks.view.rows).toHaveLength(15);
    expect(tasks.range).toBe("21–35 of 35");
    expect(tasks.previous).toBe(0);
    expect(tasks.next).toBeNull();
  });
});
