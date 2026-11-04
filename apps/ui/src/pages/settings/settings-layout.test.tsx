import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

mock.module("@/api/hooks/use-onboarding", () => ({
  isOnboardingOpen: () => false,
  useOnboarding: () => ({ data: null }),
  useOnboardingOwnsFirstRun: () => false,
}));
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
let isAdmin = true;
// The real module (full export shape), with the admin check under test control.
mock.module("@/lib/use-can", () => ({
  ...require("../../lib/use-can"),
  useIsAdmin: () => isAdmin,
}));

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

/** The bare `<span>` labels of the rail links, in order. */
function railLabels(html: string): string[] {
  return [...html.matchAll(/<span>([^<]+)<\/span>/g)].map((match) => match[1] ?? "");
}

describe("SettingsLayout", () => {
  afterEach(() => {
    isAdmin = true;
  });

  test("the side rail only shows from lg, so tablet widths keep the content column", () => {
    const html = render();
    expect(html).toContain("hidden lg:block");
    expect(html).not.toContain("md:block");
  });

  test("an admin sees the admin-only pages", () => {
    const html = render();
    expect(html).toContain("Secrets");
    expect(html).toContain("Configuration");
  });

  test("a non-admin sees only Servers and Appearance", () => {
    isAdmin = false;
    const html = render();
    expect(railLabels(html)).toEqual(["Servers", "Appearance"]);
    expect(html).not.toContain(">Advanced<");
  });

  test("an admin sees the rail in flyout order, with the Advanced group last", () => {
    const html = render();
    // The mobile tab strip repeats the labels; read the desktop rail only.
    const rail = html.slice(html.indexOf('aria-label="Settings" class="flex flex-col'));
    expect(railLabels(rail)).toEqual([
      "Servers",
      "People",
      "Appearance",
      "Configuration",
      "Extensions",
      "Repos",
      "Debug",
      "Secrets",
      "Templates",
      "Connection playground",
      "Raw fetch credentials",
    ]);
    expect(rail.indexOf(">Advanced<")).toBeLessThan(rail.indexOf("Secrets"));
    expect(rail.indexOf(">Advanced<")).toBeGreaterThan(rail.indexOf("Debug"));
    expect(html).not.toContain("Provider keys");
    expect(html).not.toContain("Integrations");
  });
});
