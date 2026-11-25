import * as z from "zod";
import type { AppDefinition, AppDefinitionPatchResult, AppValidationIssue } from "./definition";

/**
 * Small-subtree edits and reads of an app definition: one node patch, the
 * changed paths of a write, a subtree read and an outline. They let an agent
 * edit one element without reading or resending the whole definition.
 */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function editDistance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i++) {
    let previous = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const current = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length]!;
}

/** The `limit` names nearest to `name`, nearest first (substring matches rank first). */
export function closestNames(name: string, names: Iterable<string>, limit = 5): string[] {
  const needle = name.toLowerCase();
  return [...names]
    .map((candidate) => {
      const lower = candidate.toLowerCase();
      const contains = lower.includes(needle) || needle.includes(lower);
      return { candidate, score: editDistance(needle, lower) - (contains ? 100 : 0) };
    })
    .sort((a, b) => a.score - b.score || a.candidate.localeCompare(b.candidate))
    .slice(0, limit)
    .map((entry) => entry.candidate);
}

/** Element keys `set` may replace. `props` merges through `props` instead. */
const NODE_SET_KEYS = ["type", "props", "children", "on", "visible", "repeat", "watch"] as const;

export const AppNodePatchSchema = z.object({
  page: z.string().min(1).optional().describe("Page whose elements map holds the node."),
  element: z
    .string()
    .min(1)
    .optional()
    .describe("Reusable element whose elements map holds the node. Give page or element."),
  nodeId: z.string().min(1).describe("Node id in that elements map."),
  props: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Props merged one level into the node's props. null deletes a prop."),
  set: z
    .object(
      Object.fromEntries(NODE_SET_KEYS.map((key) => [key, z.unknown().optional()])) as Record<
        (typeof NODE_SET_KEYS)[number],
        z.ZodOptional<z.ZodUnknown>
      >,
    )
    .strict()
    .optional()
    .describe(
      "Node keys replaced whole (type, props, children, on, visible, repeat, watch). null deletes a key.",
    ),
  remove: z
    .literal(true)
    .optional()
    .describe(
      "Delete the node, unlink it from its parent's children, and drop its now-unreachable subtree.",
    ),
  create: z
    .object({
      parentId: z.string().min(1).describe("Existing node whose children get the new node id."),
      index: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe("Position in the parent's children. Omit to append."),
      node: z
        .record(z.string(), z.unknown())
        .describe("The new node: {type, props?, children?, ...}."),
    })
    .optional()
    .describe("Add nodeId as a new node and link it under parentId."),
});
export type AppNodePatch = z.infer<typeof AppNodePatchSchema>;

export type AppNodePatchResult =
  | AppDefinitionPatchResult
  | { success: false; issues: AppValidationIssue[]; closest: string[] };

type NodeContainer = { root?: unknown; headerActions?: unknown; elements: Record<string, unknown> };

function reachableNodes(container: NodeContainer): Set<string> {
  const reachable = new Set<string>();
  const mark = (id: unknown): void => {
    if (typeof id !== "string" || reachable.has(id) || !Object.hasOwn(container.elements, id)) {
      return;
    }
    reachable.add(id);
    const node = container.elements[id];
    if (isPlainObject(node) && Array.isArray(node.children)) node.children.forEach(mark);
  };
  mark(container.root);
  mark(container.headerActions);
  return reachable;
}

/**
 * Apply one node patch to a page's or reusable element's `elements` map,
 * without mutating `stored`. The result still goes through
 * `parseAppDefinition`, so a bad prop is reported at its full path.
 */
export function applyAppNodePatch(stored: AppDefinition, patch: AppNodePatch): AppNodePatchResult {
  const fail = (path: string, message: string, closest?: string[]): AppNodePatchResult =>
    closest
      ? { success: false, issues: [{ path, message }], closest }
      : { success: false, issues: [{ path, message }] };
  if ((patch.page === undefined) === (patch.element === undefined)) {
    return fail("page", "give exactly one of page or element");
  }
  const edits = [patch.props, patch.set, patch.remove, patch.create].filter((e) => e !== undefined);
  if (edits.length === 0) return fail("nodeId", "give props, set, remove or create");
  if ((patch.remove || patch.create) && edits.length > 1) {
    return fail("nodeId", "remove and create cannot be combined with other edits");
  }

  const definition = structuredClone(stored);
  const kind = patch.page !== undefined ? "pages" : "elements";
  const name = (patch.page ?? patch.element)!;
  const containers = (definition[kind] ?? {}) as Record<string, NodeContainer>;
  if (!Object.hasOwn(containers, name)) {
    const closest = closestNames(name, Object.keys(containers));
    return fail(
      `${kind}.${name}`,
      `unknown ${kind === "pages" ? "page" : "element"} "${name}"`,
      closest,
    );
  }
  const container = containers[name]!;
  const elementsPath = `${kind}.${name}.elements`;
  const nodePath = `${elementsPath}.${patch.nodeId}`;
  const exists = Object.hasOwn(container.elements, patch.nodeId);

  if (patch.create) {
    if (exists) return fail(nodePath, `node "${patch.nodeId}" already exists`);
    const { parentId, index, node } = patch.create;
    const parent = Object.hasOwn(container.elements, parentId)
      ? container.elements[parentId]
      : undefined;
    if (!isPlainObject(parent)) {
      return fail(
        `${elementsPath}.${parentId}`,
        `parent node "${parentId}" not found`,
        closestNames(parentId, Object.keys(container.elements)),
      );
    }
    const children = Array.isArray(parent.children) ? [...parent.children] : [];
    if (index !== undefined && index > children.length) {
      return fail(
        `${elementsPath}.${parentId}.children`,
        `index ${index} is past the end (${children.length})`,
      );
    }
    children.splice(index ?? children.length, 0, patch.nodeId);
    parent.children = children;
    container.elements[patch.nodeId] = structuredClone(node);
    return { success: true, definition };
  }

  if (!exists) {
    return fail(
      nodePath,
      `node "${patch.nodeId}" not found`,
      closestNames(patch.nodeId, Object.keys(container.elements)),
    );
  }

  if (patch.remove) {
    if (container.root === patch.nodeId || container.headerActions === patch.nodeId) {
      return fail(nodePath, "cannot remove the root or headerActions node");
    }
    for (const node of Object.values(container.elements)) {
      if (isPlainObject(node) && Array.isArray(node.children)) {
        node.children = node.children.filter((child) => child !== patch.nodeId);
      }
    }
    delete container.elements[patch.nodeId];
    const reachable = reachableNodes(container);
    for (const id of Object.keys(container.elements)) {
      if (!reachable.has(id)) delete container.elements[id];
    }
    return { success: true, definition };
  }

  const node = container.elements[patch.nodeId];
  if (!isPlainObject(node)) return fail(nodePath, "node is not an object");
  for (const [key, value] of Object.entries(patch.set ?? {})) {
    if (value === undefined) continue;
    if (value === null) delete node[key];
    else node[key] = structuredClone(value);
  }
  if (patch.props) {
    const props = isPlainObject(node.props) ? { ...node.props } : {};
    for (const [key, value] of Object.entries(patch.props)) {
      if (value === null) delete props[key];
      else props[key] = structuredClone(value);
    }
    node.props = props;
  }
  return { success: true, definition };
}

const CHANGED_PATHS_CAP = 50;

/**
 * Dot paths where `before` and `after` differ, descending through objects;
 * arrays compare whole. Capped at 50 entries; `count` is the full total.
 */
export function changedDefinitionPaths(
  before: unknown,
  after: unknown,
): { paths: string[]; count: number } {
  const paths: string[] = [];
  let count = 0;
  const walk = (a: unknown, b: unknown, path: string): void => {
    if (isPlainObject(a) && isPlainObject(b)) {
      for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
        if (path === "" && key === "schemaVersion") continue;
        walk(a[key], b[key], path ? `${path}.${key}` : key);
      }
      return;
    }
    if (Bun.deepEquals(a, b)) return;
    count += 1;
    if (paths.length < CHANGED_PATHS_CAP) paths.push(path);
  };
  walk(before, after, "");
  return { paths, count };
}

/**
 * Read one subtree by dot path (`pages.main.elements.title`) or JSON pointer
 * (`/pages/main/elements/title`). A miss names the closest keys at the level
 * that failed.
 */
export function readDefinitionPath(
  definition: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; at: string; closest: string[] } {
  const tokens = path.startsWith("/")
    ? path
        .slice(1)
        .split("/")
        .map((token) => token.replaceAll("~1", "/").replaceAll("~0", "~"))
    : path.split(".");
  let current: unknown = definition;
  for (const [depth, token] of tokens.entries()) {
    if (token === "") continue;
    const next = Array.isArray(current)
      ? /^\d+$/.test(token)
        ? current[Number(token)]
        : undefined
      : isPlainObject(current) && Object.hasOwn(current, token)
        ? current[token]
        : undefined;
    if (next === undefined) {
      return {
        ok: false,
        at: tokens.slice(0, depth + 1).join("."),
        closest: isPlainObject(current) ? closestNames(token, Object.keys(current)) : [],
      };
    }
    current = next;
  }
  return { ok: true, value: current };
}

function nodeOutline(elements: Record<string, unknown>): Record<string, [string, string[]?]> {
  const out: Record<string, [string, string[]?]> = {};
  for (const [id, node] of Object.entries(elements)) {
    const type = isPlainObject(node) && typeof node.type === "string" ? node.type : "?";
    const children =
      isPlainObject(node) && Array.isArray(node.children)
        ? node.children.filter((child): child is string => typeof child === "string")
        : [];
    out[id] = children.length > 0 ? [type, children] : [type];
  }
  return out;
}

function queryParamNames(filter: Record<string, unknown> | undefined): string[] {
  return Object.values(filter ?? {}).flatMap((value) =>
    isPlainObject(value) && typeof value.$param === "string" ? [value.$param] : [],
  );
}

/**
 * The definition's shape with no props: pages with params and node ids
 * (`{id: [type, childIds]}`), reusable elements, model column names, query
 * models and params, and action kinds.
 */
export function appDefinitionOutline(definition: AppDefinition): Record<string, unknown> {
  const pages: Record<string, unknown> = {};
  for (const [name, page] of Object.entries(definition.pages)) {
    pages[name] = {
      ...(page.title ? { title: page.title } : {}),
      ...(page.params ? { params: page.params } : {}),
      ...(page.state ? { state: Object.keys(page.state) } : {}),
      root: page.root,
      ...(page.headerActions ? { headerActions: page.headerActions } : {}),
      nodes: nodeOutline(page.elements),
    };
  }
  const elements: Record<string, unknown> = {};
  for (const [name, element] of Object.entries(definition.elements ?? {})) {
    elements[name] = {
      mode: element.mode,
      ...(element.export ? { export: true } : {}),
      ...(element.props ? { props: Object.keys(element.props) } : {}),
      root: element.root,
      nodes: nodeOutline(element.elements),
    };
  }
  const queries: Record<string, unknown> = {};
  for (const [name, query] of Object.entries(definition.queries ?? {})) {
    const params = queryParamNames(query.filter);
    queries[name] = params.length > 0 ? { model: query.model, params } : { model: query.model };
  }
  const actions: Record<string, unknown> = {};
  for (const [name, action] of Object.entries(definition.actions ?? {})) {
    actions[name] =
      action.kind === "script"
        ? { kind: action.kind, scriptId: action.scriptId }
        : action.kind === "sync"
          ? { kind: action.kind, ...(action.model ? { model: action.model } : {}) }
          : { kind: action.kind };
  }
  return {
    defaultPage: definition.defaultPage,
    ...(definition.layout ? { layout: definition.layout } : {}),
    ...(definition.state ? { state: Object.keys(definition.state) } : {}),
    ...(definition.userConfig ? { userConfig: Object.keys(definition.userConfig) } : {}),
    models: Object.fromEntries(
      Object.entries(definition.models).map(([name, model]) => [name, Object.keys(model.columns)]),
    ),
    queries,
    actions,
    pages,
    ...(Object.keys(elements).length > 0 ? { elements } : {}),
  };
}
