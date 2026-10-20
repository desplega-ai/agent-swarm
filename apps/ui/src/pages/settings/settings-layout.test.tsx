import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

mock.module("@/api/hooks/use-onboarding", () => ({ useOnboarding: () => ({ data: null }) }));
mock.module("@/lib/runtime-pools", () => ({ useRuntimePoolsGate: () => ({ open: false }) }));
mock.module("@/components/shared/animated-reveal", () =>
  require("../../components/shared/animated-reveal"),
);
mock.module("@/components/shared/beta-tag", () => ({ BetaTag: () => null }));
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

const { SettingsLayout } = await import("./settings-layout");

function render() {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={["/settings/configuration"]}>
        <SettingsLayout />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("SettingsLayout", () => {
  test("the side rail only shows from lg, so tablet widths keep the content column", () => {
    const html = render();
    expect(html).toContain("hidden lg:block");
    expect(html).not.toContain("md:block");
  });
});
