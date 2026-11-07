import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to its real file.
mock.module("@/api/hooks/use-favorites", () => require("../../api/hooks/use-favorites"));
mock.module("@/components/shared/favorite-button", () => require("../shared/favorite-button"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/tooltip", () => require("../ui/tooltip"));
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { TooltipProvider } = await import("../ui/tooltip");
const { GroupTabStar } = await import("./group-tab-star");

/** The title-row star over a seeded `key` favorites list (no request goes out). */
function renderStar(groupKey: string | null, starred: string[]) {
  const client = new QueryClient();
  client.setQueryData(["favorites", "key", undefined], {
    favorites: [],
    favoriteIds: starred,
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <TooltipProvider>
        <GroupTabStar groupKey={groupKey} />
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

describe("GroupTabStar", () => {
  test("an unstarred group offers to star it", () => {
    const html = renderStar("shared/po-qa/", ["shared/other/"]);
    expect(html).toContain('aria-label="Star this use case"');
    expect(html).not.toContain("fill-current");
  });

  test("a starred group shows a filled star that unstars", () => {
    const html = renderStar("shared/po-qa/", ["shared/po-qa/"]);
    expect(html).toContain('aria-label="Unstar"');
    expect(html).toContain("fill-current");
  });

  test("a section tab has no star", () => {
    expect(renderStar(null, ["shared/po-qa/"])).toBe("");
  });
});
