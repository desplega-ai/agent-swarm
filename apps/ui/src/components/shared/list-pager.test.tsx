import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/components/ui/button", () => import("../ui/button"));
mock.module("@/components/ui/select", () => import("../ui/select"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { ListPager, formatPagerRange, resolveListPage } = await import("./list-pager");

function render(page: number, pageSize: number, total: number) {
  return renderToStaticMarkup(
    <ListPager
      page={page}
      pageSize={pageSize}
      total={total}
      pageSizeOptions={[10, 20, 50]}
      onPageChange={() => {}}
      onPageSizeChange={() => {}}
      emptyLabel="0 tasks"
    />,
  );
}

describe("ListPager", () => {
  test("formats the visible range of the given page, never another one", () => {
    expect(formatPagerRange(0, 20, 35)).toBe("1–20 of 35");
    expect(formatPagerRange(1, 20, 35)).toBe("21–35 of 35");
    expect(formatPagerRange(0, 20, 0)).toBeNull();
    // Past the end there are no rows to describe: no range, and no silent
    // clamp to a page the list has not fetched. The caller corrects the URL.
    expect(formatPagerRange(700, 100, 28383)).toBeNull();
  });

  test("first page: range, page count, previous disabled", () => {
    const html = render(0, 20, 35);
    expect(html).toContain("1–20 of 35");
    expect(html).toContain("Page 1 of 2");
    expect(html).toMatch(/disabled=""[^>]*aria-label="Previous page"/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Next page"/);
  });

  test("five-digit totals: the row wraps instead of overflowing, controls stay right", () => {
    const html = render(281, 20, 28382);
    expect(html).toContain("5621–5640 of 28382");
    expect(html).toContain("Page 282 of 1420");
    expect(html).toMatch(/class="[^"]*\bflex-wrap\b/);
    expect(html).toMatch(/class="ml-auto /);
    const last = render(1419, 20, 28382);
    expect(last).toContain("28381–28382 of 28382");
    expect(last).toMatch(/disabled=""[^>]*aria-label="Next page"/);
  });

  test("an empty list shows the empty label and one page", () => {
    const html = render(0, 20, 0);
    expect(html).toContain("0 tasks");
    expect(html).toContain("Page 1 of 1");
    expect(html).toMatch(/disabled=""[^>]*aria-label="Next page"/);
  });
});

type Node = { props?: Record<string, unknown> } | Node[] | null | undefined;

/**
 * The page a pager button navigates to, or null when it is disabled. Clicks
 * the real handler from ListPager's element tree and reads what it passed on.
 */
function buttonTarget(tree: Node, label: string): number | null {
  const stack: Node[] = [tree];
  while (stack.length > 0) {
    const node = stack.pop();
    if (Array.isArray(node)) stack.push(...node);
    else if (node?.props) {
      if (node.props["aria-label"] === label) {
        if (node.props.disabled) return null;
        let target: number | null = null;
        const onPageChange = (next: number) => {
          target = next;
        };
        pageChangeSink = onPageChange;
        (node.props.onClick as () => void)();
        return target;
      }
      stack.push(node.props.children as Node);
    }
  }
  throw new Error(`no ${label} button`);
}
let pageChangeSink: (page: number) => void = () => {};

/**
 * Walks a server-paged list the way the Tasks and Memory pages do: fetch the
 * URL page at `page * pageSize`, resolve it against the returned total, and
 * move the URL and refetch while it is stale. Returns what the user ends on.
 */
function settle(urlPage: number, pageSize: number, rowCount: number) {
  const server = (page: number) => ({
    rows: Array.from({ length: rowCount }, (_, i) => i).slice(
      page * pageSize,
      (page + 1) * pageSize,
    ),
    total: rowCount,
  });
  let url = urlPage;
  let response = server(url);
  for (let hops = 0; ; hops++) {
    const resolved = resolveListPage(url, pageSize, response.total);
    if (!resolved.stale) break;
    if (hops > 1) throw new Error("page never settled");
    url = resolved.page;
    response = server(url);
  }
  const props = {
    page: url,
    pageSize,
    total: response.total,
    pageSizeOptions: [pageSize],
    onPageChange: (next: number) => pageChangeSink(next),
    onPageSizeChange: () => {},
    emptyLabel: "0 tasks",
  };
  const html = renderToStaticMarkup(<ListPager {...props} />);
  const tree = ListPager(props) as Node;
  return {
    url,
    rows: response.rows,
    range: html.match(/\d+–\d+ of \d+|0 tasks/)?.[0],
    pageLabel: html.match(/Page \d+ of \d+/)?.[0],
    previous: buttonTarget(tree, "Previous page"),
    next: buttonTarget(tree, "Next page"),
  };
}

describe("server-paged list with a stale ?page=", () => {
  test("one-page result: the URL moves to page 0 and the one row is fetched and shown", () => {
    // /tasks?page=1&search=<id> with a single match.
    const view = settle(1, 20, 1);
    expect(view.url).toBe(0);
    expect(view.rows).toEqual([0]);
    expect(view.range).toBe("1–1 of 1");
    expect(view.pageLabel).toBe("Page 1 of 1");
    expect(view.previous).toBeNull();
    expect(view.next).toBeNull();
  });

  test("far past the end: lands on the real last page, Previous goes to the page before it", () => {
    // /tasks?page=700 with 28,387 tasks at 100 per page.
    const view = settle(700, 100, 28387);
    expect(view.url).toBe(283);
    expect(view.rows).toHaveLength(87);
    expect(view.rows[0]).toBe(28300);
    expect(view.range).toBe(`${view.rows[0] + 1}–${view.rows[view.rows.length - 1] + 1} of 28387`);
    expect(view.pageLabel).toBe("Page 284 of 284");
    expect(view.next).toBeNull();
    expect(view.previous).toBe(282);
    // Previous is adjacent: nothing between it and the last page is skipped.
    const before = settle(view.previous as number, 100, 28387);
    expect(before.url).toBe(282);
    expect(before.range).toBe("28201–28300 of 28387");
    expect(before.next).toBe(283);
  });

  test("an in-range page is left alone", () => {
    const view = settle(1, 20, 35);
    expect(view.url).toBe(1);
    expect(view.range).toBe("21–35 of 35");
    expect(view.rows[0]).toBe(20);
    expect(view.previous).toBe(0);
    expect(view.next).toBeNull();
  });

  test("an empty result settles on page 0 with the empty label", () => {
    const view = settle(3, 20, 0);
    expect(view.url).toBe(0);
    expect(view.rows).toEqual([]);
    expect(view.range).toBe("0 tasks");
    expect(view.previous).toBeNull();
    expect(view.next).toBeNull();
  });

  test("before the total loads, a deep-linked page is kept, not reset", () => {
    expect(resolveListPage(3, 20, undefined)).toEqual({ page: 3, stale: false });
    expect(resolveListPage(Number.NaN, 20, undefined)).toEqual({ page: 0, stale: true });
    expect(resolveListPage(3, 20, 100)).toEqual({ page: 3, stale: false });
    expect(resolveListPage(3, 20, 41)).toEqual({ page: 2, stale: true });
  });
});
