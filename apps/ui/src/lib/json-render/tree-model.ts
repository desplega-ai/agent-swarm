/**
 * The pure model behind the `Tree` component: coerce an untrusted doc-shaped
 * value (`{ root, elements }`) into the flat list of visible rows, depth-first,
 * honoring collapsed branches and guarding against cycles. React-free so it
 * can be unit-tested without a DOM (`tree-model.test.ts`).
 */

export interface TreeNode {
  type?: unknown;
  children?: unknown;
}

export interface NormalizedNodes {
  root: string[];
  elements: Record<string, TreeNode>;
}

/** One visible row, with everything the renderer needs to draw it in place. */
export interface TreeRowModel {
  /**
   * Position-independent identity: the row's own key under its ancestors'
   * keys, each JSON-quoted and joined with `/`. A key reached through two
   * parents (a diamond) yields two ids, and the quoting keeps a key that
   * itself contains `/` from colliding with a nested path.
   */
  id: string;
  key: string;
  /** The node's `type`, or `?` when the node is missing or its type is not a string. */
  type: string;
  depth: number;
  /**
   * Whether this row is the last among its siblings — controls whether its
   * elbow's trunk continues below it to a following sibling.
   */
  isLast: boolean;
  /**
   * One entry per ancestor level (1..depth-1): true if that ancestor has a
   * later sibling still to come, so its trunk line must pass through this row.
   */
  ancestorLines: boolean[];
  /**
   * The row has children to show (after the cycle guard). True for a collapsed
   * or capped branch too, so the chevron renders.
   */
  hasChildren: boolean;
  /** False for a collapsed or capped row: its children are not emitted. */
  expanded: boolean;
  /**
   * The row sits at `TREE_MAX_DEPTH` and has children that are not walked
   * into. It renders a collapsed, disabled chevron.
   */
  capped: boolean;
}

/**
 * Rows emitted per walk before the outline is cut short. `nodes` is untrusted
 * and a shared subtree is expanded under every parent, so a layered DAG of a
 * few dozen elements can describe millions of rows; this bounds both the walk
 * and the DOM.
 */
export const TREE_MAX_ROWS = 2000;

/**
 * Deepest row level (0-based) that is emitted; a row at this depth keeps its
 * chevron but is not walked into.
 */
export const TREE_MAX_DEPTH = 32;

export interface FlattenedTree {
  rows: TreeRowModel[];
  /** True when the row cap cut the walk short. The depth cap marks rows `capped` instead. */
  truncated: boolean;
}

/** One pending sibling list on the depth-first walk's explicit stack. */
interface Frame {
  level: readonly string[];
  /** Index of the next sibling in `level` to emit. */
  next: number;
  depth: number;
  parentId: string | null;
  ancestors: ReadonlySet<string>;
  ancestorLines: boolean[];
}

/**
 * The non-empty string entries of an untrusted key list, first occurrence
 * only. A repeated sibling key would otherwise render twice under one parent,
 * and an empty key has nothing to show.
 */
function uniqueStringKeys(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const keys = new Set<string>();
  for (const entry of value) {
    if (typeof entry === "string" && entry !== "") keys.add(entry);
  }
  return [...keys];
}

/**
 * Coerce an untrusted `nodes` value into `{ root, elements }`, or null when it
 * is not doc-shaped. `root` is either a single key (json-render's own
 * `Spec.root`) or a list of top-level keys.
 */
export function normalizeNodes(nodes: unknown): NormalizedNodes | null {
  if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) return null;
  const { root, elements } = nodes as Record<string, unknown>;
  if (typeof root !== "string" && !Array.isArray(root)) return null;
  if (!elements || typeof elements !== "object" || Array.isArray(elements)) return null;
  return {
    root: uniqueStringKeys(typeof root === "string" ? [root] : root),
    elements: elements as Record<string, TreeNode>,
  };
}

/**
 * The node stored under `key`, ignoring inherited members — a child named
 * `constructor` or `__proto__` must read as missing, not as `Object`'s.
 */
function ownNode(elements: Record<string, TreeNode>, key: string): TreeNode | undefined {
  return Object.hasOwn(elements, key) ? elements[key] : undefined;
}

/** A node's string child keys, in order; `[]` for a missing node or malformed `children`. */
export function childKeys(node: TreeNode | undefined): string[] {
  return uniqueStringKeys(node?.children);
}

/** A node's `type` label; `?` for a missing node or a non-string `type`. */
export function nodeType(node: TreeNode | undefined): string {
  return node && typeof node.type === "string" ? node.type : "?";
}

/**
 * The visible rows in depth-first order: a key's children follow it unless
 * the key is collapsed. A key already on its own ancestor path (a cyclic doc)
 * is listed once more but not descended into, so the walk always terminates.
 * A key reachable through two different parents is listed under each.
 *
 * The walk is iterative (an explicit frame stack, so depth can never overflow
 * the call stack). It stops as soon as `TREE_MAX_ROWS` rows exist (`truncated`)
 * and does not walk into a row at `TREE_MAX_DEPTH` (that row is `capped`);
 * work is bounded by the caps, not by the size of the expansion the doc
 * describes.
 */
export function flattenVisible(
  keys: readonly string[],
  elements: Record<string, TreeNode>,
  collapsed: ReadonlySet<string>,
): FlattenedTree {
  const rows: TreeRowModel[] = [];
  let truncated = false;
  // Resolve each key's children once per walk: a key reached through many
  // parents would otherwise re-scan its `children` list every time.
  const childrenByKey = new Map<string, string[]>();
  const childrenOf = (key: string): string[] => {
    let children = childrenByKey.get(key);
    if (children === undefined) {
      children = childKeys(ownNode(elements, key));
      childrenByKey.set(key, children);
    }
    return children;
  };

  const stack: Frame[] = [
    { level: keys, next: 0, depth: 0, parentId: null, ancestors: new Set(), ancestorLines: [] },
  ];
  while (stack.length > 0) {
    const frame = stack[stack.length - 1];
    if (!frame) break;
    const key = frame.level[frame.next];
    if (key === undefined) {
      stack.pop();
      continue;
    }
    if (rows.length >= TREE_MAX_ROWS) {
      truncated = true;
      break;
    }
    const index = frame.next++;
    const children = frame.ancestors.has(key) ? [] : childrenOf(key);
    const isLast = index === frame.level.length - 1;
    const hasChildren = children.length > 0;
    const capped = hasChildren && frame.depth >= TREE_MAX_DEPTH;
    const expanded = !capped && !collapsed.has(key);
    const quoted = JSON.stringify(key);
    const id = frame.parentId === null ? quoted : `${frame.parentId}/${quoted}`;
    rows.push({
      id,
      key,
      type: nodeType(ownNode(elements, key)),
      depth: frame.depth,
      isLast,
      ancestorLines: frame.ancestorLines,
      hasChildren,
      expanded,
      capped,
    });
    if (!hasChildren || !expanded) continue;
    stack.push({
      level: children,
      next: 0,
      depth: frame.depth + 1,
      parentId: id,
      ancestors: new Set(frame.ancestors).add(key),
      ancestorLines: frame.depth === 0 ? [] : [...frame.ancestorLines, !isLast],
    });
  }
  return { rows, truncated };
}
