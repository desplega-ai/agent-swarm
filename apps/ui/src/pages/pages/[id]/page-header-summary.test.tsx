import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/utils", () => require("../../../lib/utils"));
mock.module("@/components/ui/popover", () => require("../../../components/ui/popover"));
mock.module("@/components/ui/tooltip", () => require("../../../components/ui/tooltip"));

const { PageHeaderSummary, PageHeaderSummaryDetails } = await import("./page-header-summary");
const { TooltipProvider } = await import("../../../components/ui/tooltip");

function render(description: string | null, slug: string | null): string {
  return renderToStaticMarkup(
    <TooltipProvider>
      <PageHeaderSummary description={description} slug={slug} />
    </TooltipProvider>,
  );
}

describe("PageHeaderSummary", () => {
  test("the summary is a focusable button that opens a popover, so touch and keyboard reach the full text", () => {
    const html = render("A long page description", "my-page");
    // A hover-only tooltip on a span never opens on touch; the button + popover does.
    expect(html).toMatch(/^<button type="button"[^>]*aria-haspopup="dialog"/);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('tabindex="-1"');
  });

  test("with a description the slug still renders, hidden only below sm", () => {
    const html = render("A long page description", "my-page");
    expect(html).toContain("A long page description");
    expect(html).toMatch(/class="[^"]*max-sm:hidden[^"]*">my-page</);
  });

  test("a slug without a description stays visible on phones", () => {
    const html = render(null, "my-page");
    expect(html).toContain("my-page");
    expect(html).not.toContain("max-sm:hidden");
  });

  test("renders nothing without a description or slug", () => {
    expect(render(null, null)).toBe("");
  });

  test("the popover and tooltip body carries the full description and the slug", () => {
    const html = renderToStaticMarkup(
      <PageHeaderSummaryDetails description="Full description text" slug="my-page" />,
    );
    expect(html).toContain("Full description text");
    expect(html).toContain("slug: my-page");
  });
});
