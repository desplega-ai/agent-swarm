import { describe, expect, mock, test } from "bun:test";
import type { RouteObject } from "react-router-dom";

// `bun test` cannot resolve ui's `@/` alias. Stub the modules `routes.tsx`
// imports eagerly; the lazy page imports never run.
const Stub = () => null;
mock.module("@/components/layout/root-layout", () => ({ RootLayout: Stub }));
mock.module("@/components/shared/app-update-prompt", () => ({ lazyRoute: () => Stub }));
mock.module("@/components/shared/hive-loading-screen", () => ({ HiveLoadingScreen: Stub }));
mock.module("@/pages/settings/settings-layout", () => ({ AdminRoute: Stub, SettingsLayout: Stub }));
mock.module("@/pages/usage/usage-layout", () => ({ UsageLayout: Stub }));

const { appRoutes } = await import("./routes");
const { missingNavMetadata, missingSearchProviders, navEntries, nav, unlisted } = await import(
  "../lib/command-palette/route-meta"
);

const icon = (() => null) as unknown as Parameters<typeof nav>[0]["icon"];

describe("Cmd+K route metadata", () => {
  // The "can't forget" guard: a new static route must say how it appears in Cmd+K.
  test("every static route has palette metadata or an opt-out reason", () => {
    expect(missingNavMetadata(appRoutes)).toEqual([]);
  });

  // An entity list (`/x` with `/x/:id`) must name a search provider or say why not.
  test("every entity list route has a search provider or an opt-out reason", () => {
    expect(missingSearchProviders(appRoutes)).toEqual([]);
  });

  test("the guards catch a route without metadata (positive control)", () => {
    const routes: RouteObject[] = [
      {
        path: "/",
        children: [
          { index: true, handle: nav({ title: "Home", icon }) },
          { path: "widgets", handle: nav({ title: "Widgets", icon }) },
          { path: "widgets/:id" },
          { path: "gadgets" },
          { path: "old", handle: unlisted("redirect") },
          { path: "settings", children: [{ path: "x/:id?", handle: unlisted("ok") }] },
        ],
      },
    ];
    expect(missingNavMetadata(routes)).toEqual(["/gadgets"]);
    expect(missingSearchProviders(routes)).toEqual(["/widgets", "/settings/x/:id?"]);
  });

  test("an unknown provider id is reported", () => {
    const routes: RouteObject[] = [
      { path: "/a", handle: { palette: { title: "A", icon }, search: ["nope" as "tasks"] } },
    ];
    expect(missingSearchProviders(routes)).toEqual(['/a (unknown provider "nope")']);
  });

  test("Go to lists the surfaces the old palette forgot", () => {
    const titles = navEntries(appRoutes).map((entry) => entry.title);
    for (const title of [
      "Workflows",
      "Apps",
      "Scripts",
      "Skills",
      "Memory",
      "People",
      "Templates",
      "Approvals",
      "Sessions",
      "Files",
      "Secrets",
    ]) {
      expect(titles).toContain(title);
    }
    const paths = navEntries(appRoutes).map((entry) => entry.path);
    expect(paths).toContain("/settings/extensions");
    expect(paths).not.toContain("/settings");
    expect(new Set(paths).size).toBe(paths.length);
  });
});
