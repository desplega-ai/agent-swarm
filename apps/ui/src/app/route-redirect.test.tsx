import { describe, expect, mock, test } from "bun:test";
import type { ReactElement } from "react";
import { type Location, matchRoutes } from "react-router-dom";

// `bun test` cannot resolve ui's `@/` alias. Stub the modules `routes.tsx`
// imports eagerly; the lazy page imports never run.
const Stub = () => null;
mock.module("@/components/layout/root-layout", () => ({ RootLayout: Stub }));
mock.module("@/components/shared/app-update-prompt", () => ({ lazyRoute: () => Stub }));
mock.module("@/components/shared/hive-loading-screen", () => ({ HiveLoadingScreen: Stub }));
mock.module("@/pages/settings/settings-layout", () => ({ AdminRoute: Stub, SettingsLayout: Stub }));
mock.module("@/pages/usage/usage-layout", () => ({ UsageLayout: Stub }));
mock.module("@/components/link-preview/link-preview-state", () => ({ LinkPreviewScope: Stub }));

const { appRoutes } = await import("./routes");
const { RouteRedirect, redirectTarget } = await import("./route-redirect");

type RedirectProps = Parameters<typeof RouteRedirect>[0];

/** Where the route table sends `url`: the final URL, or null when no redirect matches. */
function resolve(url: string): string | null {
  const parsed = new URL(url, "http://ui.test");
  const matches = matchRoutes(appRoutes, parsed.pathname);
  const leaf = matches?.at(-1);
  const element = leaf?.route.element as ReactElement<RedirectProps> | undefined;
  if (!leaf || element?.type !== RouteRedirect) return null;
  const location = {
    pathname: parsed.pathname,
    search: parsed.search,
    hash: parsed.hash,
  } as Location;
  const { to, drop } = element.props;
  const target = typeof to === "string" ? to : to(leaf.params, location);
  return redirectTarget(target, location, drop);
}

describe("redirectTarget", () => {
  test("keeps the incoming query and hash", () => {
    expect(redirectTarget("/b", { search: "?x=1&y=2", hash: "#h" })).toBe("/b?x=1&y=2#h");
  });

  test("target params and hash win over incoming ones", () => {
    expect(redirectTarget("/b?tab=mcp#t", { search: "?tab=old&q=1", hash: "#h" })).toBe(
      "/b?tab=mcp&q=1#t",
    );
  });

  test("dropped params are left behind", () => {
    expect(redirectTarget("/b", { search: "?category=llm&search=x", hash: "" }, ["category"])).toBe(
      "/b?search=x",
    );
  });
});

describe("moved routes", () => {
  const cases: Array<[string, string]> = [
    ["/connections", "/integrations/tools?tab=connections"],
    ["/connections?tab=oauth-apps", "/integrations/tools?tab=oauth-apps"],
    ["/connections?tab=playground", "/settings/connection-playground"],
    ["/connections?tab=bindings&search=gh", "/settings/fetch-credentials?search=gh"],
    [
      "/connections?search=x&kind=mcp&scope=agent&new=connection",
      "/integrations/tools?tab=connections&search=x&kind=mcp&scope=agent&new=connection",
    ],
    ["/connections/c1#ops", "/integrations/tools/connections/c1#ops"],
    ["/connections/oauth-apps/o1", "/integrations/tools/oauth-apps/o1"],
    ["/settings/integrations", "/integrations/tools"],
    ["/settings/integrations?category=comm", "/integrations/channels"],
    ["/settings/integrations?category=llm&search=open", "/integrations/ai?search=open"],
    ["/settings/integrations?category=issues", "/integrations/tools"],
    ["/settings/integrations/slack?search=x", "/integrations/slack?search=x"],
    [
      "/mcp-servers?new=1&name=foo&url=https%3A%2F%2Fx&transport=http",
      "/integrations/tools?tab=mcp&new=1&name=foo&url=https%3A%2F%2Fx&transport=http",
    ],
    [
      "/mcp-servers/m1?oauth=success&tab=tools",
      "/integrations/tools/mcp-servers/m1?oauth=success&tab=tools",
    ],
    [
      "/mcp-servers/m1?error=denied&error_description=no",
      "/integrations/tools/mcp-servers/m1?error=denied&error_description=no",
    ],
    ["/settings/api-keys", "/integrations/ai"],
    ["/keys", "/integrations/ai"],
    ["/integrations", "/integrations/tools"],
    ["/integrations/tools/mcp-servers", "/integrations/tools?tab=mcp"],
    ["/integrations/tools/connections", "/integrations/tools?tab=connections"],
    ["/integrations/tools/oauth-apps", "/integrations/tools?tab=oauth-apps"],
    ["/script-runs?x=1", "/scripts?tab=runs&x=1"],
  ];
  for (const [from, to] of cases) {
    test(`${from} → ${to}`, () => {
      expect(resolve(from)).toBe(to);
    });
  }

  test("the Connect pages and detail routes are not redirects", () => {
    for (const path of [
      "/integrations/channels",
      "/integrations/tools",
      "/integrations/ai",
      "/integrations/slack",
      "/integrations/tools/connections/c1",
      "/integrations/tools/oauth-apps/o1",
      "/integrations/tools/mcp-servers/m1",
      "/settings/connection-playground",
      "/settings/fetch-credentials",
    ]) {
      expect({ path, redirect: resolve(path) }).toEqual({ path, redirect: null });
    }
  });
});
