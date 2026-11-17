import { describe, expect, mock, test } from "bun:test";
import { ArrowLeftToLine } from "lucide-react";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/components/ui/badge", () => require("../../ui/badge"));
mock.module("@/components/ui/button", () => require("../../ui/button"));
mock.module("@/components/ui/context-menu", () => require("../../ui/context-menu"));
mock.module("@/components/ui/dropdown-menu", () => require("../../ui/dropdown-menu"));
mock.module("@/components/ui/kbd", () => require("../../ui/kbd"));
mock.module("@/components/ui/tooltip", () => require("../../ui/tooltip"));
mock.module("@/lib/sessions-v2", () => require("../../../lib/sessions-v2"));
mock.module("@/lib/utils", () => require("../../../lib/utils"));
// The tab's title and marks come from the session queries: a fixed title
// stands in for them. No other test imports `tab-info`, so this stub (it
// leaks process-wide) reaches only this file.
mock.module("./tab-info", () => ({
  useTabInfo: (tab: string) => ({ title: `Title ${tab}`, tip: tab, unread: false }),
  tabLabel: (info: { title: string }) => info.title,
  TabIcon: () => null,
  TabActivity: () => null,
}));

const { TooltipProvider } = await import("../../ui/tooltip");
const { GROUP_TAB, NEW_SESSION_TAB } = await import("../../../lib/sessions-v2");
const { TabStrip } = await import("./tab-strip");
type TabMove = import("./tab-strip").TabMove;
type TabMoveState = import("./tab-strip").TabMoveState;

function renderStrip(tabs: string[], state: (tab: string) => TabMoveState) {
  const move: TabMove = {
    label: "Move to split pane",
    icon: ArrowLeftToLine,
    state,
    onMove: () => {},
  };
  return renderToStaticMarkup(
    <TooltipProvider>
      <TabStrip
        tabs={tabs}
        selected={tabs[0]}
        view={null}
        label="Tabs"
        panelId="panel"
        tabId={(tab) => `tab-${tab}`}
        paneActive
        draggable
        move={move}
        onFocusTab={() => {}}
        onCloseTab={() => {}}
      />
    </TooltipProvider>,
  );
}

/** The markup of one tab: from its `role="tab"` to the next one. */
function tabMarkup(html: string, tab: string): string {
  const start = html.indexOf(`id="tab-${tab}"`);
  const end = html.indexOf('role="tab"', start + 1);
  return html.slice(start, end < 0 ? undefined : end);
}

describe("TabStrip move action", () => {
  test("each movable tab has a move button next to its close button", () => {
    const html = renderStrip(["a", NEW_SESSION_TAB], () => "ready");
    for (const tab of ["a", NEW_SESSION_TAB]) {
      const markup = tabMarkup(html, tab);
      expect(markup).toContain('aria-label="Move to split pane"');
      expect(markup).not.toContain('aria-disabled="true"');
      expect(markup).toContain('aria-label="Close tab Title');
    }
  });

  test("a blocked move stays visible but off, and a tab that cannot move has none", () => {
    const html = renderStrip(["a", GROUP_TAB], (tab) =>
      tab === GROUP_TAB ? "hidden" : { blocked: "Open a second session first. Then split." },
    );
    expect(tabMarkup(html, "a")).toContain('aria-disabled="true"');
    expect(tabMarkup(html, GROUP_TAB)).not.toContain("Move to split pane");
  });

  test("a tab is the context menu's trigger, for a right-click or Shift+F10", () => {
    const html = renderStrip(["a"], () => "ready");
    // The tooltip's `data-slot` wins on the shared element. Radix's context menu
    // trigger marks it with its touch-callout style.
    expect(tabMarkup(html, "a")).toContain("-webkit-touch-callout:none");
  });
});
