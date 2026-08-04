/**
 * Element-reference assembly (Phase 6).
 *
 * `apps/ui` has no test runner of its own, so the assembler is a PURE,
 * alias-free module and is exercised here by the root runner through a
 * relative import. No React, no store, no server — just spec in, spec out.
 */

import { describe, expect, test } from "bun:test";
import {
  type AppRecordLike,
  type AssembledPage,
  assemblePageSpec,
  collectElementRefAppIds,
  DEFINING_APP_PARAM,
  ELEMENT_KEYS,
  MAX_ELEMENT_REF_DEPTH,
  REWRITE_COVERAGE,
} from "../../apps/ui/src/lib/json-render/assemble";

/**
 * The mirrored-constant contract: the client list must match the server's.
 * Read as SOURCE TEXT rather than imported — `src/apps/page-validator` pulls
 * in `src/apps/definition`, which opens the database, and the whole point of
 * the assembler is that it stays free of that.
 */
function serverElementKeys(): string[] {
  const source = require("node:fs").readFileSync(
    new URL("../apps/page-validator.ts", import.meta.url),
    "utf8",
  ) as string;
  const block = /export const ELEMENT_KEYS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
  if (!block) throw new Error("ELEMENT_KEYS not found in src/apps/page-validator.ts");
  return [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

const NOTES_ID = "11111111-1111-4111-8111-111111111111";
const CONSUMER_ID = "22222222-2222-4222-8222-222222222222";

function notesApp(): AppRecordLike {
  return {
    id: NOTES_ID,
    name: "Notes Mini",
    definition: {
      pages: {
        main: { root: "root", elements: { root: { type: "Container", props: {} } } },
      },
      elements: {
        statCard: {
          mode: "pure",
          export: true,
          props: {
            label: { kind: "string", required: true },
            value: { kind: "string", default: "0" },
            flag: { kind: "boolean" },
          },
          root: "card",
          elements: {
            card: {
              type: "Container",
              props: {},
              children: ["label", "value", "search", "slot"],
              visible: { $state: "/props/flag", eq: true },
            },
            label: { type: "Text", props: { content: { $state: "/props/label" } } },
            value: { type: "Text", props: { content: { $state: "/props/value" } } },
            search: { type: "SearchInput", props: { id: "q", label: "Search" } },
            slot: { type: "ElementSlot", props: {} },
          },
        },
        recentNotes: {
          mode: "bound",
          export: true,
          root: "wrap",
          elements: {
            wrap: { type: "Stack", props: {}, children: ["filterInput", "table", "refreshBtn"] },
            filterInput: { type: "SearchInput", props: { id: "filter" } },
            table: {
              type: "Table",
              props: {
                data: { $state: "/queries/all/data" },
                search: { $state: "/ui/filter/value" },
                rowActions: [
                  {
                    label: "Delete",
                    actions: [
                      {
                        action: "app.mutate",
                        params: { model: "note", op: "delete", rowId: { $row: "id" } },
                      },
                    ],
                  },
                ],
              },
              repeat: { statePath: "/queries/all/data", key: "id" },
            },
            refreshBtn: {
              type: "Button",
              props: { label: "Refresh" },
              on: { press: [{ action: "app.refresh", params: { query: "all" } }] },
              watch: {
                "/queries/pinnedOnly/data": [{ action: "app.action", params: { name: "sync" } }],
              },
              visible: { $state: "/actions/sync/status", eq: "ok" },
            },
          },
        },
        privateCard: {
          mode: "pure",
          root: "box",
          elements: { box: { type: "Card", props: { title: "private" } } },
        },
      },
    },
  };
}

function consumerApp(overrides: Record<string, unknown> = {}): AppRecordLike {
  return {
    id: CONSUMER_ID,
    name: "Element Consumer",
    definition: {
      pages: {
        main: {
          root: "root",
          elements: {
            root: { type: "Stack", props: {}, children: ["statA", "statB", "notes", "localRef"] },
            statA: {
              type: "ElementRef",
              props: {
                app: NOTES_ID,
                element: "statCard",
                props: {
                  label: "Notes",
                  value: { $state: "/queries/mine/data/0/count" },
                  flag: true,
                },
              },
              children: ["extra"],
            },
            statB: {
              type: "ElementRef",
              props: { app: NOTES_ID, element: "statCard", props: { label: "Other" } },
            },
            extra: { type: "Text", props: { content: "consumer child" } },
            notes: { type: "ElementRef", props: { app: NOTES_ID, element: "recentNotes" } },
            localRef: {
              type: "ElementRef",
              props: { element: "ownBound", props: { title: "Local" } },
            },
          },
        },
        second: {
          root: "root",
          elements: {
            root: { type: "Stack", props: {}, children: ["reuse"] },
            reuse: {
              type: "ElementRef",
              props: { element: "ownBound", props: { title: "Reused" } },
            },
          },
        },
      },
      elements: {
        ownBound: {
          mode: "bound",
          props: { title: { kind: "string" } },
          root: "box",
          elements: {
            box: { type: "Card", props: { title: { $state: "/props/title" } }, children: ["own"] },
            own: {
              type: "Table",
              props: { data: { $state: "/queries/own/data" } },
              on: { press: [{ action: "app.refresh", params: { query: "own" } }] },
            },
          },
        },
      },
      ...overrides,
    },
  };
}

function assemble(consumer = consumerApp(), page = "main", apps: AppRecordLike[] = [notesApp()]) {
  return assemblePageSpec(consumer, page, new Map(apps.map((app) => [app.id, app])));
}

function node(spec: AssembledPage["spec"], id: string) {
  return (spec?.elements[id] ?? undefined) as Record<string, any> | undefined;
}

describe("assemblePageSpec — expansion", () => {
  test("replaces the ElementRef node with the target's root subtree", () => {
    const { spec, issues } = assemble();
    expect(issues).toEqual([]);
    expect(spec).not.toBeNull();
    // Root children point at instance-prefixed ids, and the ElementRef node
    // itself is gone from the spec.
    expect(node(spec, "root")?.children).toEqual([
      "ref:statA:card",
      "ref:statB:card",
      "ref:notes:wrap",
      "ref:localRef:box",
    ]);
    expect(spec?.elements.statA).toBeUndefined();
    expect(node(spec, "ref:statA:card")?.type).toBe("Container");
    // No ElementRef / ElementSlot survives assembly — the runtime registry
    // never has to know those node types exist.
    for (const raw of Object.values(spec?.elements ?? {})) {
      expect(["ElementRef", "ElementSlot"]).not.toContain((raw as { type: string }).type);
    }
  });

  test("reports the instance → defining-app mapping", () => {
    const { instances, definingAppIds } = assemble();
    expect(instances.map((i) => [i.instanceKey, i.definingAppId, i.mode, i.foreign])).toEqual([
      ["statA", NOTES_ID, "pure", true],
      ["statB", NOTES_ID, "pure", true],
      ["notes", NOTES_ID, "bound", true],
      ["localRef", CONSUMER_ID, "bound", false],
    ]);
    expect(definingAppIds).toEqual([NOTES_ID]);
  });

  test("missing page yields a null spec instead of throwing", () => {
    expect(assemble(consumerApp(), "nope").spec).toBeNull();
  });
});

describe("assemblePageSpec — rewrite coverage across ELEMENT_KEYS", () => {
  test("the coverage table enumerates every element key (and the tree root)", () => {
    expect([...ELEMENT_KEYS].sort()).toEqual(serverElementKeys().sort());
    const covered = REWRITE_COVERAGE.map((rule) => rule.field).sort();
    expect(covered).toEqual([...ELEMENT_KEYS, "root"].sort());
    for (const rule of REWRITE_COVERAGE) {
      expect(rule.rewrites.length).toBeGreaterThan(0);
      expect(rule.note.length).toBeGreaterThan(0);
    }
  });

  const { spec } = assemble();

  test("type — copied verbatim", () => {
    expect(node(spec, "ref:notes:table")?.type).toBe("Table");
  });

  test("root — the element's own root is the instance-prefixed id", () => {
    expect(node(spec, "ref:notes:wrap")).toBeDefined();
    expect(node(spec, "root")?.children).toContain("ref:notes:wrap");
  });

  test("children — id arrays are remapped into the instance namespace", () => {
    expect(node(spec, "ref:notes:wrap")?.children).toEqual([
      "ref:notes:filterInput",
      "ref:notes:table",
      "ref:notes:refreshBtn",
    ]);
  });

  test("props — state paths, interaction ids and nested action chains", () => {
    const table = node(spec, "ref:notes:table");
    expect(table?.props.data).toEqual({ $state: `/refs/${NOTES_ID}/queries/all/data` });
    // `/ui/<id>` follows the rewritten interaction id of the same instance.
    expect(table?.props.search).toEqual({ $state: "/ui/instances/notes/filter/value" });
    expect(node(spec, "ref:notes:filterInput")?.props.id).toBe("instances/notes/filter");
    // Action chains nested inside props (Table.rowActions) are rewritten too.
    expect(table?.props.rowActions[0].actions[0].params).toEqual({
      model: "note",
      op: "delete",
      rowId: { $row: "id" },
      [DEFINING_APP_PARAM]: NOTES_ID,
    });
  });

  test("on — handler chains carry the defining app", () => {
    expect(node(spec, "ref:notes:refreshBtn")?.on.press[0].params).toEqual({
      query: "all",
      [DEFINING_APP_PARAM]: NOTES_ID,
    });
  });

  test("watch — chains AND the observed-path map keys are rewritten", () => {
    const watch = node(spec, "ref:notes:refreshBtn")?.watch;
    expect(Object.keys(watch)).toEqual([`/refs/${NOTES_ID}/queries/pinnedOnly/data`]);
    expect(watch[`/refs/${NOTES_ID}/queries/pinnedOnly/data`][0].params).toEqual({
      name: "sync",
      [DEFINING_APP_PARAM]: NOTES_ID,
    });
  });

  test("visible — conditions are rewritten (and statically folded on literals)", () => {
    expect(node(spec, "ref:notes:refreshBtn")?.visible).toEqual({
      $state: `/refs/${NOTES_ID}/actions/sync/status`,
      eq: "ok",
    });
    // `flag: true` supplied → the condition folds to `true`; `statB` omits it
    // (no default) → folds to `false`.
    expect(node(spec, "ref:statA:card")?.visible).toBe(true);
    expect(node(spec, "ref:statB:card")?.visible).toBe(false);
  });

  test("repeat — `statePath` is a raw path string and is rewritten", () => {
    expect(node(spec, "ref:notes:table")?.repeat).toEqual({
      statePath: `/refs/${NOTES_ID}/queries/all/data`,
      key: "id",
    });
  });
});

describe("assemblePageSpec — props", () => {
  test("substitutes literals, consumer bindings and declared defaults", () => {
    const { spec } = assemble();
    expect(node(spec, "ref:statA:label")?.props.content).toBe("Notes");
    expect(node(spec, "ref:statA:value")?.props.content).toEqual({
      $state: "/queries/mine/data/0/count",
    });
    // `statB` supplies no `value` → the element's declared default.
    expect(node(spec, "ref:statB:value")?.props.content).toBe("0");
  });

  test("an undeclared, unsupplied prop resolves to undefined, not a dangling ref", () => {
    const consumer = consumerApp();
    const page = consumer.definition.pages!.main!;
    (page.elements.statA as any).props.props = { label: "Only label" };
    const { spec } = assemble(consumer);
    expect(node(spec, "ref:statA:value")?.props.content).toBe("0");
    expect(node(spec, "ref:statA:label")?.props.content).toBe("Only label");
  });
});

describe("assemblePageSpec — ElementSlot", () => {
  test("splices the consumer's children at the slot position", () => {
    const { spec } = assemble();
    expect(node(spec, "ref:statA:card")?.children).toEqual([
      "ref:statA:label",
      "ref:statA:value",
      "ref:statA:search",
      "extra",
    ]);
    // The consumer child is emitted in the CONSUMER's namespace, unprefixed.
    expect(node(spec, "extra")?.props.content).toBe("consumer child");
    // No children supplied → the slot simply disappears.
    expect(node(spec, "ref:statB:card")?.children).toEqual([
      "ref:statB:label",
      "ref:statB:value",
      "ref:statB:search",
    ]);
  });
});

describe("assemblePageSpec — instance scoping", () => {
  test("two instances of one element hold independent interaction state", () => {
    const { spec } = assemble();
    expect(node(spec, "ref:statA:search")?.props.id).toBe("instances/statA/q");
    expect(node(spec, "ref:statB:search")?.props.id).toBe("instances/statB/q");
  });

  test("an explicit instanceKey overrides the referencing node id", () => {
    const consumer = consumerApp();
    (consumer.definition.pages!.main!.elements.statB as any).props.instanceKey = "pinned";
    const { spec } = assemble(consumer);
    expect(node(spec, "ref:pinned:search")?.props.id).toBe("instances/pinned/q");
  });
});

describe("assemblePageSpec — data-plane refs", () => {
  test("a foreign bound element reads through /refs/<definingAppId>", () => {
    const { boundQueries } = assemble();
    expect(boundQueries).toEqual({ [NOTES_ID]: ["all", "pinnedOnly"] });
  });

  test("a same-app bound element keeps the consuming app's own slots", () => {
    const { spec, boundQueries } = assemble();
    expect(node(spec, "ref:localRef:own")?.props.data).toEqual({ $state: "/queries/own/data" });
    // No `$app` marker either — the consumer's own routes are the target.
    expect(node(spec, "ref:localRef:own")?.on.press[0].params).toEqual({ query: "own" });
    expect(boundQueries[CONSUMER_ID]).toBeUndefined();
  });

  test("same-app reuse works on a second page of the same app", () => {
    const { spec, issues } = assemble(consumerApp(), "second");
    expect(issues).toEqual([]);
    expect(node(spec, "ref:reuse:box")?.props.title).toBe("Reused");
    expect(node(spec, "ref:reuse:own")?.props.data).toEqual({ $state: "/queries/own/data" });
  });
});

describe("assemblePageSpec — failure modes render error cards", () => {
  function refPage(refProps: Record<string, unknown>): AppRecordLike {
    return {
      id: CONSUMER_ID,
      definition: {
        pages: {
          main: {
            root: "root",
            elements: {
              root: { type: "Stack", props: {}, children: ["r"] },
              r: { type: "ElementRef", props: refProps },
            },
          },
        },
      },
    };
  }

  test("unresolvable app", () => {
    const { spec, issues, missingAppIds } = assemble(
      refPage({ app: "33333333-3333-4333-8333-333333333333", element: "statCard" }),
    );
    expect(node(spec, "r")?.type).toBe("Alert");
    expect(node(spec, "r")?.props.tone).toBe("error");
    expect(missingAppIds).toEqual(["33333333-3333-4333-8333-333333333333"]);
    expect(issues[0]?.path).toBe("r");
  });

  test("an app still being fetched gets a neutral loading card, not an error", () => {
    const consumer = refPage({ app: NOTES_ID, element: "statCard" });
    const { spec, issues, missingAppIds } = assemblePageSpec(consumer, "main", new Map(), {
      pendingAppIds: [NOTES_ID],
    });
    expect(node(spec, "r")?.props.tone).toBe("info");
    expect(issues).toEqual([]);
    expect(missingAppIds).toEqual([]);
  });

  test("element deleted from the defining app", () => {
    const { spec, issues } = assemble(refPage({ app: NOTES_ID, element: "goneCard" }));
    expect(node(spec, "r")?.type).toBe("Alert");
    expect(issues[0]?.message).toContain("was not found");
  });

  test("element un-exported by the defining app (the broken float)", () => {
    const { spec, issues } = assemble(refPage({ app: NOTES_ID, element: "privateCard" }));
    expect(node(spec, "r")?.type).toBe("Alert");
    expect(issues[0]?.message).toContain("is not exported");
  });

  test("reference cycle", () => {
    const cyclic: AppRecordLike = {
      id: CONSUMER_ID,
      definition: {
        pages: {
          main: {
            root: "root",
            elements: {
              root: { type: "Stack", props: {}, children: ["r"] },
              r: { type: "ElementRef", props: { element: "loop" } },
            },
          },
        },
        elements: {
          loop: {
            mode: "pure",
            root: "box",
            elements: {
              box: { type: "Container", props: {}, children: ["again"] },
              again: { type: "ElementRef", props: { element: "loop" } },
            },
          },
        },
      },
    };
    const { spec, issues } = assemble(cyclic, "main", []);
    // The refused ref stays a node of the instance that contained it.
    expect(node(spec, "ref:r:box")?.children).toEqual(["ref:r:again"]);
    expect(node(spec, "ref:r:again")?.type).toBe("Alert");
    expect(issues[0]?.message).toContain("references itself");
  });

  test(`nesting deeper than ${MAX_ELEMENT_REF_DEPTH} levels`, () => {
    const elements: Record<string, unknown> = {};
    // chain: e1 → e2 → … → e7, each referencing the next.
    for (let level = 1; level <= 7; level += 1) {
      elements[`e${level}`] = {
        mode: "pure",
        root: "box",
        elements: {
          box: { type: "Container", props: {}, children: level < 7 ? ["next"] : [] },
          ...(level < 7
            ? { next: { type: "ElementRef", props: { element: `e${level + 1}` } } }
            : {}),
        },
      };
    }
    const deep: AppRecordLike = {
      id: CONSUMER_ID,
      definition: {
        pages: {
          main: {
            root: "root",
            elements: {
              root: { type: "Stack", props: {}, children: ["r"] },
              r: { type: "ElementRef", props: { element: "e1" } },
            },
          },
        },
        elements: elements as never,
      },
    };
    const { spec, issues } = assemble(deep, "main", []);
    // Levels 1..5 expand; the 6th reference is refused, matching the server's
    // MAX_ELEMENT_REF_DEPTH.
    const deepestKey = "r.next.next.next.next";
    expect(node(spec, `ref:${deepestKey}:box`)).toBeDefined();
    expect(node(spec, `ref:${deepestKey}:next`)?.type).toBe("Alert");
    expect(issues[0]?.message).toContain("maximum reference depth");
  });
});

/**
 * One element referenced once from `main` as node `r`, so every assertion
 * below reads `ref:r:<id>`. `foreign` puts the element in a second app (and
 * exports it), which is what turns on the `/refs` + `$app` rewrites.
 */
function elementFixture(
  element: Record<string, unknown>,
  supplied: Record<string, unknown> = {},
  foreign = false,
): { consumer: AppRecordLike; apps: AppRecordLike[] } {
  const refProps: Record<string, unknown> = { element: "el", props: supplied };
  if (foreign) refProps.app = NOTES_ID;
  const consumer: AppRecordLike = {
    id: CONSUMER_ID,
    definition: {
      pages: {
        main: {
          root: "root",
          elements: {
            root: { type: "Stack", props: {}, children: ["r"] },
            r: { type: "ElementRef", props: refProps },
          },
        },
      },
      ...(foreign ? {} : { elements: { el: element as never } }),
    },
  };
  const apps = foreign
    ? [
        {
          id: NOTES_ID,
          name: "Notes Mini",
          definition: { elements: { el: { export: true, ...element } as never } },
        },
      ]
    : [];
  return { consumer, apps };
}

function assembleElement(
  element: Record<string, unknown>,
  supplied: Record<string, unknown> = {},
  foreign = false,
) {
  const { consumer, apps } = elementFixture(element, supplied, foreign);
  return assemble(consumer, "main", apps);
}

describe("assemblePageSpec — condition folding (a literal may never reach `visible`)", () => {
  // The renderer's `evaluateCondition` does `"$and" in condition`, which throws
  // a TypeError on a bare string/number — so the bare truthiness form must fold
  // to a boolean exactly like the comparison forms do.
  const truthy = (kind: string) => ({
    mode: "pure",
    props: { p: { kind } },
    root: "box",
    elements: { box: { type: "Container", props: {}, visible: { $state: "/props/p" } } },
  });

  test.each([
    ["non-empty string", "string", { p: "hi" }, true],
    ["empty string", "string", { p: "" }, false],
    ["number 0", "number", { p: 0 }, false],
    ["number 3", "number", { p: 3 }, true],
    ["boolean true", "boolean", { p: true }, true],
    ["boolean false", "boolean", { p: false }, false],
    ["unsupplied optional prop", "string", {}, false],
  ])("%s folds to %s", (_label, kind, supplied, expected) => {
    const { spec } = assembleElement(truthy(kind as string), supplied as Record<string, unknown>);
    expect(node(spec, "ref:r:box")?.visible).toBe(expected);
  });

  test("a consumer BINDING keeps the condition dynamic", () => {
    const { spec } = assembleElement(truthy("string"), {
      p: { $state: "/queries/mine/data/0/flag" },
    });
    expect(node(spec, "ref:r:box")?.visible).toEqual({ $state: "/queries/mine/data/0/flag" });
  });

  test("folding reaches inside $and / $or arrays", () => {
    const element = {
      mode: "pure",
      props: { p: { kind: "string" } },
      root: "box",
      elements: {
        box: {
          type: "Container",
          props: {},
          visible: { $and: [{ $state: "/props/p" }, { $state: "/props/p", eq: "on" }] },
        },
      },
    };
    const { spec } = assembleElement(element, { p: "on" });
    expect(node(spec, "ref:r:box")?.visible).toEqual({ $and: [true, true] });
  });

  test("a $cond expression's test folds too", () => {
    const element = {
      mode: "pure",
      props: { p: { kind: "boolean" } },
      root: "box",
      elements: {
        box: {
          type: "Text",
          props: { content: { $cond: { $state: "/props/p" }, $then: "yes", $else: "no" } },
        },
      },
    };
    const { spec } = assembleElement(element, { p: false });
    expect(node(spec, "ref:r:box")?.props.content).toEqual({
      $cond: false,
      $then: "yes",
      $else: "no",
    });
  });
});

describe("assemblePageSpec — comparison inversion against a live right-hand side", () => {
  const compare = (operator: string) => ({
    mode: "bound",
    props: { min: { kind: "number" } },
    root: "box",
    elements: {
      box: {
        type: "Container",
        props: {},
        visible: { $state: "/props/min", [operator]: { $state: "/queries/q/data/0/n" } },
      },
    },
  });

  test("eq keeps the live side as the head", () => {
    const { spec } = assembleElement(compare("eq"), { min: 5 });
    expect(node(spec, "ref:r:box")?.visible).toEqual({ $state: "/queries/q/data/0/n", eq: 5 });
  });

  test("an ordered comparator is flipped, not folded", () => {
    const { spec } = assembleElement(compare("lt"), { min: 5 });
    // `5 < live` ⟺ `live > 5`
    expect(node(spec, "ref:r:box")?.visible).toEqual({ $state: "/queries/q/data/0/n", gt: 5 });
  });

  test("`not` survives the flip", () => {
    const element = compare("gte");
    (element.elements.box as any).visible.not = true;
    const { spec } = assembleElement(element, { min: 2 });
    expect(node(spec, "ref:r:box")?.visible).toEqual({
      $state: "/queries/q/data/0/n",
      lte: 2,
      not: true,
    });
  });

  test("the flipped side is the REWRITTEN path inside a borrowed element", () => {
    const { spec } = assembleElement(compare("eq"), { min: 5 }, true);
    expect(node(spec, "ref:r:box")?.visible).toEqual({
      $state: `/refs/${NOTES_ID}/queries/q/data/0/n`,
      eq: 5,
    });
  });

  test("an unsupplied prop is not inverted — it folds to false", () => {
    const { spec } = assembleElement(compare("eq"), {});
    expect(node(spec, "ref:r:box")?.visible).toBe(false);
  });
});

describe("assemblePageSpec — the `$app` routing marker is assembler-owned", () => {
  const mutate = (params: Record<string, unknown>) => ({
    type: "Button",
    props: { label: "Go" },
    on: { press: [{ action: "app.mutate", params }] },
  });

  test("an authored $app on a PAGE node is deleted", () => {
    const consumer: AppRecordLike = {
      id: CONSUMER_ID,
      definition: {
        pages: {
          main: {
            root: "root",
            elements: {
              root: { type: "Stack", props: {}, children: ["btn"] },
              btn: mutate({
                model: "m",
                op: "create",
                $app: "99999999-9999-4999-8999-999999999999",
              }),
            },
          },
        },
      },
    };
    const { spec } = assemble(consumer, "main", []);
    expect(node(spec, "btn")?.on.press[0].params).toEqual({ model: "m", op: "create" });
  });

  test("an authored $app inside a same-app element is deleted", () => {
    const element = {
      mode: "bound",
      root: "btn",
      elements: {
        btn: mutate({ model: "m", op: "create", $app: "99999999-9999-4999-8999-999999999999" }),
      },
    };
    const { spec } = assembleElement(element);
    expect(node(spec, "ref:r:btn")?.on.press[0].params).toEqual({ model: "m", op: "create" });
  });

  test("an authored $app inside a borrowed element is OVERWRITTEN with the defining app", () => {
    const element = {
      mode: "bound",
      root: "btn",
      elements: {
        btn: mutate({ model: "m", op: "create", $app: "99999999-9999-4999-8999-999999999999" }),
      },
    };
    const { spec } = assembleElement(element, {}, true);
    expect(node(spec, "ref:r:btn")?.on.press[0].params[DEFINING_APP_PARAM]).toBe(NOTES_ID);
  });
});

describe("assemblePageSpec — form ids", () => {
  const element = {
    mode: "bound",
    root: "wrap",
    elements: {
      wrap: { type: "Stack", props: {}, children: ["form", "btn"] },
      form: {
        type: "Form",
        props: {
          id: "newThing",
          fields: [{ name: "title", label: "Title", kind: "string" }],
          onSubmit: [
            { action: "app.mutate", params: { model: "m", op: "create", formId: "newThing" } },
          ],
        },
      },
      btn: {
        type: "Button",
        props: { label: "Save" },
        on: {
          press: [
            { action: "app.mutate", params: { model: "m", op: "create", formId: "newThing" } },
          ],
        },
      },
    },
  };

  test("an explicit formId is namespaced exactly like the Form's props.id", () => {
    const { spec } = assembleElement(element);
    const formId = node(spec, "ref:r:form")?.props.id;
    expect(formId).toBe("instances/r/newThing");
    // Both action sites agree with the Form, so the surface's post-create
    // `store.set('/forms/' + formId, {})` clears THIS instance's draft.
    expect(node(spec, "ref:r:form")?.props.onSubmit[0].params.formId).toBe(formId);
    expect(node(spec, "ref:r:btn")?.on.press[0].params.formId).toBe(formId);
  });

  test("a formId that names no form in the element is left alone", () => {
    const stray = {
      mode: "bound",
      root: "btn",
      elements: {
        btn: {
          type: "Button",
          props: { label: "Save" },
          on: {
            press: [
              { action: "app.mutate", params: { model: "m", op: "create", formId: "elsewhere" } },
            ],
          },
        },
      },
    };
    const { spec } = assembleElement(stray);
    expect(node(spec, "ref:r:btn")?.on.press[0].params.formId).toBe("elsewhere");
  });
});

describe("collectElementRefAppIds", () => {
  test("collects direct foreign targets and follows resolved apps", () => {
    expect(collectElementRefAppIds(consumerApp())).toEqual([NOTES_ID]);
  });

  test("finds a second-level target once the first app is resolved", () => {
    const notes = notesApp();
    const thirdId = "44444444-4444-4444-8444-444444444444";
    notes.definition.elements!.statCard!.elements.nested = {
      type: "ElementRef",
      props: { app: thirdId, element: "deep" },
    };
    const resolved = new Map([[NOTES_ID, notes]]);
    expect(collectElementRefAppIds(consumerApp(), resolved).sort()).toEqual(
      [NOTES_ID, thirdId].sort(),
    );
  });
});
