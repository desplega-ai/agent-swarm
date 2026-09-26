import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/components/ui/button", () => import("../ui/button"));
mock.module("@/components/ui/select", () => import("../ui/select"));
mock.module("@/lib/utils", () => import("../../lib/utils"));

const { ListPager, formatPagerRange } = await import("./list-pager");

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
  test("formats the visible range, clamped to the total", () => {
    expect(formatPagerRange(0, 20, 35)).toBe("1–20 of 35");
    expect(formatPagerRange(1, 20, 35)).toBe("21–35 of 35");
    expect(formatPagerRange(0, 20, 0)).toBeNull();
    // A URL page past the end reads as the last page, never "70001–28383".
    expect(formatPagerRange(700, 100, 28383)).toBe("28301–28383 of 28383");
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
