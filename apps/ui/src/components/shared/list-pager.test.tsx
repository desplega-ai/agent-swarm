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
  });

  test("first page: range, page count, previous disabled", () => {
    const html = render(0, 20, 35);
    expect(html).toContain("1–20 of 35");
    expect(html).toContain("Page 1 of 2");
    expect(html).toMatch(/disabled=""[^>]*aria-label="Previous page"/);
    expect(html).not.toMatch(/disabled=""[^>]*aria-label="Next page"/);
  });

  test("an empty list shows the empty label and one page", () => {
    const html = render(0, 20, 0);
    expect(html).toContain("0 tasks");
    expect(html).toContain("Page 1 of 1");
    expect(html).toMatch(/disabled=""[^>]*aria-label="Next page"/);
  });
});
