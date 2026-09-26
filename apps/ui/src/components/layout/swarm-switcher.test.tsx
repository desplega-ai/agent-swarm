import { describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The test runner cannot resolve ui's `@/` alias (see review-ack.test.tsx), so
// each aliased module in this component's graph maps to a real file or a stub.
mock.module("@/lib/utils", () => import("../../lib/utils"));
mock.module("@/components/ui/tooltip", () => import("../ui/tooltip"));
mock.module("@/components/ui/dropdown-menu", () => import("../ui/dropdown-menu"));
mock.module("@/components/ui/sidebar", () => ({
  SidebarMenu: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
  SidebarMenuItem: ({ children }: { children: ReactNode }) => <li>{children}</li>,
  SidebarMenuButton: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
mock.module("@/api/hooks/use-stats", () => ({
  useHealth: () => ({ data: { version: "1.156.0" }, isError: false }),
}));
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: undefined }),
}));
mock.module("react-router-dom", () => ({ useNavigate: () => () => {} }));
mock.module("@/hooks/use-config", () => ({
  useConfig: () => ({
    connections: [],
    activeConnection: { id: "env", name: "Production", apiUrl: "https://api.example.dev" },
    connectionLocked: true,
    switchConnection: () => {},
  }),
}));

const { TooltipProvider } = await import("../ui/tooltip");
const { SwarmSwitcher } = await import("./swarm-switcher");

describe("SwarmSwitcher", () => {
  test("a deployment-locked connection is still a keyboard tab stop with a focus ring", () => {
    const html = renderToStaticMarkup(
      <TooltipProvider>
        <SwarmSwitcher />
      </TooltipProvider>,
    );
    // The tooltip carrying the URL and version must open from the keyboard, so
    // its trigger is a native button (focusable) with a visible focus ring.
    expect(html).toMatch(/<button type="button"[^>]*focus-visible:ring-2[^>]*>/);
    expect(html).toContain("Production");
    expect(html).not.toContain('<div class="flex h-8 w-full');
  });
});
