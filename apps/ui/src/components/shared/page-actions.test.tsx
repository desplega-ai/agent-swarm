import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to a real file or a stub.
let phone = false;
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/hooks/use-mobile", () => ({ useIsPhone: () => phone }));
mock.module("@/components/sessions-v2/mobile/action-sheet", () => ({
  // Closed sheets render nothing, like the real drawer.
  ActionSheet: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <div>{children}</div> : null,
}));

const { PageActions } = await import("./page-actions");

function render() {
  return renderToStaticMarkup(
    <PageActions
      title="Shadow (noop) PR judge"
      primary={<button type="button">Star</button>}
      more={<button type="button">Export PDF</button>}
    >
      <button type="button">Desktop row</button>
    </PageActions>,
  );
}

describe("PageActions", () => {
  test("md and up renders the desktop row untouched", () => {
    phone = false;
    const html = render();
    expect(html).toBe('<button type="button">Desktop row</button>');
  });

  test("a phone shows the primary controls and one More actions button, with the rest in the sheet", () => {
    phone = true;
    const html = render();
    expect(html).not.toContain("Desktop row");
    expect(html).toContain("Star");
    expect(html).toContain('aria-label="More actions"');
    // The sheet's rows mount only once it opens.
    expect(html).not.toContain("Export PDF");
  });
});
