import { describe, expect, test } from "bun:test";
import { parseAppDefinition } from "../apps/definition";

/**
 * Validator coverage for `PageFrame`: a literal `pageId` must be a page id,
 * a binding or an empty id passes, and `device` is desktop | mobile.
 */

const PAGE_ID = "8b8077e8b7a94dfc89c88636889a46ac";

function definition(props: Record<string, unknown>) {
  return {
    models: {},
    pages: {
      studio: {
        title: "Studio",
        params: { pageId: { kind: "string" } },
        root: "preview",
        elements: { preview: { type: "PageFrame", props } },
      },
    },
    defaultPage: "studio",
  };
}

async function issuesFor(props: Record<string, unknown>) {
  const parsed = await parseAppDefinition(definition(props));
  return parsed.success ? [] : parsed.issues.map((issue) => issue.path);
}

describe("PageFrame validation", () => {
  test("a literal id, a bound id and an empty id validate", async () => {
    expect(await issuesFor({ pageId: PAGE_ID, device: "mobile", height: "720px" })).toEqual([]);
    expect(await issuesFor({ pageId: { $state: "/route/params/pageId" }, fill: true })).toEqual([]);
    expect(await issuesFor({ pageId: "" })).toEqual([]);
  });

  test("a slug or path as a literal id is rejected", async () => {
    for (const pageId of ["my-page", "../api/keys", `${PAGE_ID}0`]) {
      expect(await issuesFor({ pageId })).toEqual(["pages.studio.elements.preview.props.pageId"]);
    }
  });

  test("device is desktop or mobile", async () => {
    const issues = await issuesFor({ pageId: PAGE_ID, device: "tablet" });
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((path) => path.includes("device"))).toBe(true);
  });
});

/**
 * The `appContext` bridge props (`actions`, `expose`) inside a reusable element:
 * a pure element runs no actions, and both lists stay literal so every name and
 * path is checked here, not resolved at runtime past the script-only rule.
 */
describe("PageFrame appContext bridge validation", () => {
  const SCRIPT_ID = "00000000-0000-0000-0000-000000000000";

  function bridgeDefinition(
    page: Record<string, unknown>,
    element?: { mode: "pure" | "bound"; props: Record<string, unknown> },
  ) {
    return {
      models: { note: { columns: { title: { kind: "string" } } } },
      queries: { allNotes: { model: "note" } },
      actions: {
        run: { kind: "script", scriptId: SCRIPT_ID },
        work: { kind: "task", prompt: "do it" },
      },
      ...(element
        ? {
            elements: {
              frame: {
                mode: element.mode,
                export: true,
                root: "f",
                elements: {
                  f: { type: "PageFrame", props: { pageId: PAGE_ID, ...element.props } },
                },
              },
            },
          }
        : {}),
      pages: {
        main: {
          title: "Main",
          params: { names: { kind: "string" } },
          root: "f",
          elements: { f: { type: "PageFrame", props: { pageId: PAGE_ID, ...page } } },
        },
      },
      defaultPage: "main",
    };
  }

  async function bridgeIssues(def: unknown) {
    const parsed = await parseAppDefinition(def);
    return parsed.success
      ? []
      : parsed.issues
          .filter((entry) => !entry.path.startsWith("actions."))
          .map((entry) => entry.path);
  }

  test("a pure element's frame cannot run actions", async () => {
    expect(
      await bridgeIssues(bridgeDefinition({}, { mode: "pure", props: { actions: ["run"] } })),
    ).toEqual(["elements.frame.elements.f.props.actions"]);
  });

  test("a pure element's frame cannot expose app state outside its props", async () => {
    const issues = await bridgeIssues(
      bridgeDefinition({}, { mode: "pure", props: { expose: ["/queries/allNotes/data"] } }),
    );
    expect(issues).toEqual(["elements.frame.elements.f.props.expose.0"]);
  });

  test("a bound exported element's frame takes script actions and query reads, not task actions", async () => {
    expect(
      await bridgeIssues(
        bridgeDefinition(
          {},
          { mode: "bound", props: { actions: ["run"], expose: ["/queries/allNotes/data"] } },
        ),
      ),
    ).toEqual([]);
    expect(
      await bridgeIssues(bridgeDefinition({}, { mode: "bound", props: { actions: ["work"] } })),
    ).toEqual(["elements.frame.elements.f.props.actions.0"]);
  });

  test("actions and expose given as an expression are rejected", async () => {
    const names = { $state: "/route/params/names" };
    expect(await bridgeIssues(bridgeDefinition({ actions: names }))).toEqual([
      "pages.main.elements.f.props.actions",
    ]);
    expect(await bridgeIssues(bridgeDefinition({ expose: names }))).toEqual([
      "pages.main.elements.f.props.expose",
    ]);
    // A bound element also flags the `/route` read itself; the literal-list rule is the one asserted.
    expect(
      await bridgeIssues(bridgeDefinition({}, { mode: "bound", props: { actions: names } })),
    ).toContain("elements.frame.elements.f.props.actions");
  });

  test("an inherited Object property is not an app action", async () => {
    const parsed = await parseAppDefinition(bridgeDefinition({ actions: ["constructor"] }));
    const issues = parsed.success ? [] : parsed.issues;
    expect(issues.map((entry) => `${entry.path}: ${entry.message}`)).toContain(
      'pages.main.elements.f.props.actions.0: unknown app action "constructor"',
    );
  });
});
