import { describe, expect, test } from "bun:test";
import { newSessionContextKey } from "../components/session-panel/model";
import {
  buildPageContextFooter,
  getPageContext,
  isPanelHiddenOn,
  pageContextLabel,
} from "./page-context";

function ctx(pathname: string) {
  const c = getPageContext({ pathname });
  if (!c) throw new Error(`expected a context for ${pathname}`);
  return c;
}

describe("getPageContext — entity routes", () => {
  const cases: Array<[string, string, string]> = [
    ["/agents/a1", "agent", "a1"],
    ["/tasks/t1", "task", "t1"],
    ["/workflows/w1", "workflow", "w1"],
    ["/workflow-runs/r1", "workflow-run", "r1"],
    ["/schedules/s1", "schedule", "s1"],
    ["/scripts/sc1", "script", "sc1"],
    ["/script-runs/sr1", "script-run", "sr1"],
    ["/pages/p1", "page", "p1"],
    ["/apps/ap1", "app", "ap1"],
    ["/apps/ap1/p/settings", "app", "ap1"],
    ["/skills/sk1", "skill", "sk1"],
    ["/templates/tp1", "template", "tp1"],
    ["/templates/tp1/history/3", "template", "tp1"],
    ["/mcp-servers/m1", "mcp-server", "m1"],
    ["/repos/rp1", "repo", "rp1"],
    ["/people/u1", "person", "u1"],
    ["/connections/c1", "connection", "c1"],
    ["/approval-requests/ar1", "approval-request", "ar1"],
  ];
  for (const [pathname, kind, ref] of cases) {
    test(`${pathname} → ${kind}:${ref}`, () => {
      const c = ctx(pathname);
      expect(c.kind).toBe(kind);
      expect(c.ref).toBe(ref);
      expect(c.pageKey).toBe(`task:ui:${kind}:${ref}`);
    });
  }

  test("a static list segment is not read as an entity id", () => {
    expect(ctx("/people/unmapped").pageKey).toBe("task:ui:route:people.unmapped");
  });
});

describe("getPageContext — route fallback", () => {
  test("list and settings pages key by their dotted path", () => {
    expect(ctx("/workflows").pageKey).toBe("task:ui:route:workflows");
    expect(ctx("/settings/configuration").pageKey).toBe("task:ui:route:settings.configuration");
    expect(ctx("/connections/oauth-apps/o1").pageKey).toBe(
      "task:ui:route:connections.oauth-apps.o1",
    );
  });

  test("the home page keys as `home`", () => {
    const c = ctx("/");
    expect(c.pageKey).toBe("task:ui:route:home");
    expect(pageContextLabel(c)).toBe("Home");
  });
});

describe("pageContextLabel", () => {
  test("entity pages show the kind and a short id; other routes show the path", () => {
    expect(pageContextLabel(ctx("/agents/86505d2a-e7b7-4eb8-b9e9-77a7e5f5d780"))).toBe(
      "Agent 86505d2a",
    );
    expect(pageContextLabel(ctx("/workflow-runs/r1"))).toBe("Workflow run r1");
    expect(pageContextLabel(ctx("/tasks"))).toBe("/tasks");
  });
});

describe("getPageContext — key safety", () => {
  test("`:` inside an id is percent-encoded so it never adds a key part", () => {
    const c = ctx("/agents/a%3Ab");
    expect(c.ref).toBe("a:b");
    expect(c.pageKey).toBe("task:ui:agent:a%3Ab");
    expect(c.pageKey.split(":")).toHaveLength(4);
  });

  test("route fallback encodes `:` too", () => {
    expect(ctx("/chat/x%3Ay").pageKey).toBe("task:ui:route:chat.x%3Ay");
  });

  test("session keys add exactly one part under the page key", () => {
    const key = newSessionContextKey("task:ui:workflow:w1");
    expect(key.startsWith("task:ui:workflow:w1:")).toBe(true);
    expect(key.split(":")).toHaveLength(5);
    expect(newSessionContextKey("task:ui:workflow:w1")).not.toBe(key);
  });
});

describe("hidden routes", () => {
  for (const pathname of ["/sessions", "/sessions/abc", "/setup", "/setup/connect"]) {
    test(`hidden on ${pathname}`, () => {
      expect(isPanelHiddenOn(pathname)).toBe(true);
      expect(getPageContext({ pathname })).toBeNull();
    });
  }

  test("not hidden on a look-alike prefix", () => {
    expect(isPanelHiddenOn("/sessions-archive")).toBe(false);
  });
});

describe("buildPageContextFooter", () => {
  test("entity pages carry URL, route, entity and title", () => {
    const c = getPageContext({
      pathname: "/workflows/abc",
      url: "https://ui.example/workflows/abc?tab=runs",
      title: "Workflow abc",
    });
    expect(c && buildPageContextFooter(c)).toBe(
      [
        "---",
        "Page context (swarm UI)",
        "- URL: https://ui.example/workflows/abc?tab=runs",
        "- Route: /workflows/:id",
        "- Entity: workflow abc",
        "- Title: Workflow abc",
      ].join("\n"),
    );
  });

  test("route pages omit the entity line, and an empty title is dropped", () => {
    const footer = buildPageContextFooter(ctx("/settings/configuration"));
    expect(footer).not.toContain("- Entity:");
    expect(footer).not.toContain("- Title:");
    expect(footer).toContain("- Route: /settings/configuration");
  });
});
