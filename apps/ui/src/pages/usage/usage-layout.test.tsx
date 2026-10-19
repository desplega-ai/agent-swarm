import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

mock.module("@/components/shared/section-tabs", () =>
  require("../../components/shared/section-tabs"),
);
mock.module("@/components/ui/button", () => ({
  Button: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => children,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => children,
  TooltipContent: () => null,
}));
mock.module("@/hooks/use-url-search-state", () => require("../../hooks/use-url-search-state"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { UsageLayout } = await import("./usage-layout");

function render() {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/usage"]}>
      <UsageLayout />
    </MemoryRouter>,
  );
}

describe("UsageLayout", () => {
  test("the side rail only shows from lg, so tablet widths keep the date and filter controls", () => {
    const html = render();
    expect(html).toMatch(/<nav aria-label="Usage" class="[^"]*\bhidden lg:flex\b/);
    expect(html).not.toMatch(/<nav aria-label="Usage" class="[^"]*md:flex/);
  });
});
