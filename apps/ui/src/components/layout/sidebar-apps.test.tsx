import { expect, mock, test } from "bun:test";
import type { ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";

let query = {
  data: undefined as { apps: { id: string; name: string }[] } | undefined,
  isError: false,
};
mock.module("@/api/hooks/use-apps", () => ({ useApps: () => query }));
mock.module("@/hooks/use-app-sidebar-preferences", () => ({
  useAppSidebarPreferences: () => ({ preferences: { mode: "all", selectedIds: [] } }),
}));
mock.module("@/lib/app-sidebar-preferences", () => require("../../lib/app-sidebar-preferences"));
mock.module("@/lib/use-can", () => ({ useIsAdmin: () => true }));
mock.module("@/components/icons/layout-grid", () => ({ LayoutGridIcon: () => null }));
const wrapper = ({ children }: { children: ReactNode }) => <div>{children}</div>;
mock.module("@/components/shared/collapsible-section", () => ({ CollapsibleSection: wrapper }));
mock.module("@/components/ui/sidebar", () => ({
  SidebarGroup: wrapper,
  SidebarGroupContent: wrapper,
  SidebarMenu: wrapper,
  SidebarMenuButton: wrapper,
  SidebarMenuItem: wrapper,
}));
const { SidebarApps } = await import("./sidebar-apps");
const render = () =>
  renderToString(
    <MemoryRouter>
      <SidebarApps />
    </MemoryRouter>,
  );

test("a polling error keeps cached app links; an initial error still offers the catalog", () => {
  query = { data: undefined, isError: true };
  expect(render()).toContain('href="/apps"');
  expect(render()).not.toContain('href="/apps/cached"');
  query = { data: { apps: [{ id: "cached", name: "Cached workspace" }] }, isError: false };
  expect(render()).toContain('href="/apps/cached"');
  query = { ...query, isError: true };
  expect(render()).toContain('href="/apps/cached"');
  expect(render()).toContain("Cached workspace");
});
