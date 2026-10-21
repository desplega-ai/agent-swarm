import { describe, expect, test } from "bun:test";
import {
  childKeys,
  flattenVisible,
  nodeType,
  normalizeNodes,
  TREE_MAX_DEPTH,
  TREE_MAX_ROWS,
  type TreeNode,
  type TreeRowModel,
} from "./tree-model";

/** `a` holds `b` and `c`; `b` holds `e`; `d` is a second top-level key. */
const elements: Record<string, TreeNode> = {
  a: { type: "Stack", children: ["b", "c"] },
  b: { type: "Card", children: ["e"] },
  c: { type: "Text" },
  d: { type: "Text" },
  e: { type: "Badge" },
};

const none = new Set<string>();
const keysOf = (rows: TreeRowModel[]) => rows.map((row) => row.key);
/** The rows of a walk, for the tests that are about order and shape rather than the caps. */
const visible = (
  keys: readonly string[],
  nodes: Record<string, TreeNode>,
  collapsed: ReadonlySet<string> = none,
) => flattenVisible(keys, nodes, collapsed).rows;

describe("normalizeNodes", () => {
  test("accepts root as a list of keys", () => {
    expect(normalizeNodes({ root: ["a", "d"], elements })).toEqual({ root: ["a", "d"], elements });
  });

  test("accepts root as a single key (json-render's own Spec.root)", () => {
    expect(normalizeNodes({ root: "a", elements })).toEqual({ root: ["a"], elements });
  });

  test("keeps only non-empty string root keys, first occurrence of each", () => {
    expect(normalizeNodes({ root: ["a", 2, null, "", "d", "a"], elements })?.root).toEqual([
      "a",
      "d",
    ]);
    expect(normalizeNodes({ root: "", elements })?.root).toEqual([]);
  });

  test("an empty root normalizes to no rows rather than null", () => {
    expect(normalizeNodes({ root: [], elements })).toEqual({ root: [], elements });
  });

  test("rejects anything that is not doc-shaped", () => {
    expect(normalizeNodes(null)).toBeNull();
    expect(normalizeNodes(undefined)).toBeNull();
    expect(normalizeNodes("a")).toBeNull();
    expect(normalizeNodes(["a"])).toBeNull();
    expect(normalizeNodes({})).toBeNull();
    expect(normalizeNodes({ root: 1, elements })).toBeNull();
    expect(normalizeNodes({ root: { a: 1 }, elements })).toBeNull();
    expect(normalizeNodes({ root: ["a"] })).toBeNull();
    expect(normalizeNodes({ root: ["a"], elements: null })).toBeNull();
    expect(normalizeNodes({ root: ["a"], elements: [] })).toBeNull();
    expect(normalizeNodes({ root: ["a"], elements: "a" })).toBeNull();
  });
});

describe("childKeys", () => {
  test("returns the string children in order, deduplicated", () => {
    expect(childKeys({ children: ["b", "c", "b"] })).toEqual(["b", "c"]);
  });

  test("skips empty strings, non-string entries and non-array children", () => {
    expect(childKeys({ children: ["b", "", 1, {}, null, "c"] })).toEqual(["b", "c"]);
    expect(childKeys({ children: "b" })).toEqual([]);
    expect(childKeys({})).toEqual([]);
    expect(childKeys(undefined)).toEqual([]);
  });
});

describe("nodeType", () => {
  test("returns the string type", () => {
    expect(nodeType({ type: "Text" })).toBe("Text");
  });

  test("returns ? for a missing node or a non-string type", () => {
    expect(nodeType(undefined)).toBe("?");
    expect(nodeType({})).toBe("?");
    expect(nodeType({ type: 1 })).toBe("?");
  });
});

describe("flattenVisible", () => {
  test("lists keys depth-first, children right after their parent", () => {
    expect(keysOf(visible(["a", "d"], elements, none))).toEqual(["a", "b", "e", "c", "d"]);
  });

  test("each row carries its type, depth and connector geometry", () => {
    const rows = visible(["a", "d"], elements, none);
    const geometry = rows.map(({ key, type, depth, isLast, ancestorLines, hasChildren }) => ({
      key,
      type,
      depth,
      isLast,
      ancestorLines,
      hasChildren,
    }));
    expect(geometry).toEqual([
      { key: "a", type: "Stack", depth: 0, isLast: false, ancestorLines: [], hasChildren: true },
      { key: "b", type: "Card", depth: 1, isLast: false, ancestorLines: [], hasChildren: true },
      // `b` has a later sibling (`c`), so its trunk passes through `e`.
      {
        key: "e",
        type: "Badge",
        depth: 2,
        isLast: true,
        ancestorLines: [true],
        hasChildren: false,
      },
      { key: "c", type: "Text", depth: 1, isLast: true, ancestorLines: [], hasChildren: false },
      { key: "d", type: "Text", depth: 0, isLast: true, ancestorLines: [], hasChildren: false },
    ]);
    expect(rows.every((row) => row.expanded)).toBe(true);
    expect(rows.some((row) => row.capped)).toBe(false);
  });

  test("a collapsed key hides its subtree but still reports children", () => {
    const rows = visible(["a", "d"], elements, new Set(["a"]));
    expect(keysOf(rows)).toEqual(["a", "d"]);
    expect(rows[0]).toMatchObject({ key: "a", hasChildren: true, expanded: false });
    expect(keysOf(visible(["a", "d"], elements, new Set(["b"])))).toEqual(["a", "b", "c", "d"]);
  });

  test("a child key missing from elements still gets a ? row", () => {
    const rows = visible(["a"], { a: { type: "Stack", children: ["ghost"] } }, none);
    expect(rows.map(({ key, type }) => ({ key, type }))).toEqual([
      { key: "a", type: "Stack" },
      { key: "ghost", type: "?" },
    ]);
  });

  test("inherited object members are not nodes", () => {
    const rows = visible(["constructor", "__proto__", "toString"], {}, none);
    expect(rows.map(({ key, type, hasChildren }) => ({ key, type, hasChildren }))).toEqual([
      { key: "constructor", type: "?", hasChildren: false },
      { key: "__proto__", type: "?", hasChildren: false },
      { key: "toString", type: "?", hasChildren: false },
    ]);
  });

  test("an own key that shadows an inherited member is honored", () => {
    // JSON.parse creates own properties even for `__proto__`.
    const own = JSON.parse(
      '{"__proto__":{"type":"Stack","children":["x"]},"constructor":{"type":"Text"},"x":{"type":"Badge"}}',
    ) as Record<string, TreeNode>;
    expect(keysOf(visible(["__proto__", "constructor"], own, none))).toEqual([
      "__proto__",
      "x",
      "constructor",
    ]);
    expect(visible(["constructor"], own, none)[0]?.type).toBe("Text");
  });

  test("a cycle terminates: the repeated key is listed once more, not descended into", () => {
    const cyclic: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b"] },
      b: { type: "Stack", children: ["a"] },
    };
    const rows = visible(["a"], cyclic, none);
    expect(keysOf(rows)).toEqual(["a", "b", "a"]);
    expect(rows[2]?.hasChildren).toBe(false);
    expect(keysOf(visible(["a"], { a: { type: "Stack", children: ["a"] } }, none))).toEqual([
      "a",
      "a",
    ]);
  });

  test("a key reachable twice outside its own ancestry is expanded both times", () => {
    const diamond: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b", "c"] },
      b: { type: "Stack", children: ["d"] },
      c: { type: "Stack", children: ["d"] },
      d: { type: "Text" },
    };
    expect(keysOf(visible(["a"], diamond, none))).toEqual(["a", "b", "d", "c", "d"]);
  });

  test("row ids are unique even when keys repeat or contain the separator", () => {
    const tricky: Record<string, TreeNode> = {
      a: { type: "Stack", children: ["b", "a/b"] },
      b: { type: "Stack", children: ["a"] },
      "a/b": { type: "Text" },
    };
    const rows = visible(["a", "a/b"], tricky, none);
    expect(keysOf(rows)).toEqual(["a", "b", "a", "a/b", "a/b"]);
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);
  });

  test("an empty root yields no rows", () => {
    expect(visible([], elements, none)).toEqual([]);
  });
});

describe("flattenVisible caps", () => {
  /**
   * `levels` layers of two keys, each pointing at both keys of the next layer:
   * 2^levels root-to-leaf paths described by 2 * levels elements.
   */
  function layeredDag(levels: number) {
    const dag: Record<string, TreeNode> = {};
    for (let i = 0; i < levels; i++) {
      const children = i + 1 < levels ? [`L${i + 1}a`, `L${i + 1}b`] : undefined;
      dag[`L${i}a`] = { type: "Stack", children };
      dag[`L${i}b`] = { type: "Stack", children };
    }
    return { root: ["L0a", "L0b"], elements: dag };
  }

  function chain(length: number) {
    const line: Record<string, TreeNode> = {};
    for (let i = 0; i < length; i++) {
      line[`n${i}`] = { type: "Stack", children: i + 1 < length ? [`n${i + 1}`] : undefined };
    }
    return { root: ["n0"], elements: line };
  }

  function wide(count: number) {
    const root = Array.from({ length: count }, (_, i) => `k${i}`);
    const leaves: Record<string, TreeNode> = {};
    for (const key of root) leaves[key] = { type: "Text" };
    return { root, elements: leaves };
  }

  const walk = (doc: { root: string[]; elements: Record<string, TreeNode> }) =>
    flattenVisible(doc.root, doc.elements, none);
  const cappedKeys = (rows: TreeRowModel[]) =>
    rows.filter((row) => row.capped).map((row) => row.key);

  // No timing assertions: an exponential regression would hang into Bun's
  // per-test timeout, and the row-count assertions already fail without the cap.

  test("a normal doc is neither truncated nor capped", () => {
    const { rows, truncated } = flattenVisible(["a", "d"], elements, none);
    expect(truncated).toBe(false);
    expect(cappedKeys(rows)).toEqual([]);
  });

  test("a layered shared-subtree DAG is cut at TREE_MAX_ROWS rows", () => {
    const { rows, truncated } = walk(layeredDag(40));
    expect(rows.length).toBe(TREE_MAX_ROWS);
    expect(truncated).toBe(true);
  });

  test("the row cap is exact: TREE_MAX_ROWS rows pass, one more is cut", () => {
    const exact = walk(wide(TREE_MAX_ROWS));
    expect(exact.rows.length).toBe(TREE_MAX_ROWS);
    expect(exact.truncated).toBe(false);

    const over = walk(wide(TREE_MAX_ROWS + 1));
    expect(over.rows.length).toBe(TREE_MAX_ROWS);
    expect(over.truncated).toBe(true);
  });

  test("a 50,000-key doc is cut at the row cap without walking the rest", () => {
    const { rows, truncated } = walk(wide(50_000));
    expect(rows.length).toBe(TREE_MAX_ROWS);
    expect(truncated).toBe(true);
  });

  test("a 50,000-element chain does not overflow the stack: its last row is capped, not truncated", () => {
    const { rows, truncated } = walk(chain(50_000));
    expect(truncated).toBe(false);
    expect(rows.length).toBe(TREE_MAX_DEPTH + 1);
    expect(rows.at(-1)).toMatchObject({
      key: `n${TREE_MAX_DEPTH}`,
      depth: TREE_MAX_DEPTH,
      hasChildren: true,
      expanded: false,
      capped: true,
    });
    expect(cappedKeys(rows)).toEqual([`n${TREE_MAX_DEPTH}`]);
  });

  test("the depth cap is exact: a chain ending at TREE_MAX_DEPTH has no capped row, one deeper does", () => {
    const fits = walk(chain(TREE_MAX_DEPTH + 1));
    expect(fits.rows.length).toBe(TREE_MAX_DEPTH + 1);
    expect(fits.truncated).toBe(false);
    expect(cappedKeys(fits.rows)).toEqual([]);
    expect(fits.rows.at(-1)).toMatchObject({ depth: TREE_MAX_DEPTH, hasChildren: false });

    const over = walk(chain(TREE_MAX_DEPTH + 2));
    expect(over.rows.length).toBe(TREE_MAX_DEPTH + 1);
    expect(over.truncated).toBe(false);
    expect(over.rows.at(-1)).toMatchObject({
      depth: TREE_MAX_DEPTH,
      hasChildren: true,
      expanded: false,
      capped: true,
    });
  });

  test("a capped row stays capped and collapsed whatever the collapsed set says", () => {
    const deep = chain(100);
    const result = flattenVisible(deep.root, deep.elements, new Set([`n${TREE_MAX_DEPTH}`]));
    expect(result.rows.length).toBe(TREE_MAX_DEPTH + 1);
    expect(result.truncated).toBe(false);
    expect(result.rows.at(-1)).toMatchObject({ capped: true, expanded: false });
  });

  test("a doc can be both truncated and capped", () => {
    const leaves = wide(TREE_MAX_ROWS);
    const line = chain(100);
    const { rows, truncated } = flattenVisible(
      ["n0", ...leaves.root],
      { ...line.elements, ...leaves.elements },
      none,
    );
    expect(truncated).toBe(true);
    expect(rows.length).toBe(TREE_MAX_ROWS);
    expect(cappedKeys(rows)).toEqual([`n${TREE_MAX_DEPTH}`]);
  });
});
