/**
 * Targeted reads of a stored KV value: a dot path into a JSON value plus an
 * offset/limit window over the array items, object keys, or string characters
 * found there. Shared by the kv-get MCP tool, the REST GET routes behind
 * `ctx.swarm.kv_get`, and the ctx-control spill shape summary, so every path
 * the summary prints is a path kv-get accepts.
 *
 * Pure functions only: no DB access, safe to import from any side.
 */

export type KvViewArgs = { path?: string; offset?: number; limit?: number };

export type KvViewType = "object" | "array" | "string" | "number" | "boolean" | "null";

export type KvView = {
  /** Dot path that was resolved; "" is the whole value. */
  path: string;
  type: KvViewType;
  /** Array items, object keys, or string characters at `path`. */
  total?: number;
  offset?: number;
  returned?: number;
  /** Offset of the next page, or null when this page reaches the end. */
  nextOffset?: number | null;
};

export type KvViewResult =
  | { ok: true; value: unknown; view: KvView }
  | { ok: false; error: string };

/** Longest `path` kv-get accepts. */
export const KV_PATH_MAX_CHARS = 1024;

/** JSON-encoded path bytes a spill shape summary may spend across its entries. */
export const KV_SHAPE_PATH_BUDGET_BYTES = 2048;

function pathBytes(path: string): number {
  return Buffer.byteLength(JSON.stringify(path), "utf8");
}

export type KvShapeEntry = {
  path: string;
  type: KvViewType;
  bytes: number;
  /** Array items, object keys, or string characters. */
  items?: number;
};

export function hasKvViewArgs(args: KvViewArgs): boolean {
  return args.path !== undefined || args.offset !== undefined || args.limit !== undefined;
}

export function kvViewType(value: unknown): KvViewType {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return "array";
  switch (typeof value) {
    case "object":
      return "object";
    case "string":
      return "string";
    case "number":
    case "bigint":
      return "number";
    case "boolean":
      return "boolean";
    default:
      return "null";
  }
}

/**
 * The JSON root of a stored value. `string` entries whose text parses to an
 * object or array (MCP spill payloads are stored this way) are treated as
 * JSON; any other string stays a plain string.
 */
export function kvViewRoot(value: unknown): { root: unknown; json: boolean } {
  if (typeof value !== "string") return { root: value, json: true };
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed !== null && typeof parsed === "object") return { root: parsed, json: true };
  } catch {
    // Not JSON: fall through to plain-string handling.
  }
  return { root: value, json: false };
}

function itemCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return value.length;
  if (value !== null && typeof value === "object") return Object.keys(value).length;
  return undefined;
}

/**
 * Split a dot path into keys. `\.` is a literal dot and `\\` a literal
 * backslash, so object keys containing dots stay addressable.
 */
export function splitKvPath(path: string): string[] {
  const segments: string[] = [];
  let current = "";
  for (let i = 0; i < path.length; i++) {
    const char = path[i] as string;
    if (char === "\\" && i + 1 < path.length) {
      current += path[++i];
    } else if (char === ".") {
      segments.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  segments.push(current);
  return segments;
}

/** Inverse of `splitKvPath`: escape each key and join with dots. */
export function joinKvPath(segments: string[]): string {
  return segments.map((key) => key.replace(/[\\.]/g, "\\$&")).join(".");
}

function resolvePath(
  root: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (path === "") return { ok: true, value: root };
  const segments = splitKvPath(path);
  if (segments.some((segment) => segment === "")) {
    return {
      ok: false,
      error: `path "${path}" has an empty segment; use dot paths like "data.rows"`,
    };
  }
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    const at = joinKvPath(segments.slice(0, i)) || "(root)";
    if (Array.isArray(current)) {
      const index = /^\d+$/.test(segment) ? Number(segment) : Number.NaN;
      if (!(index < current.length)) {
        return {
          ok: false,
          error: `path "${path}" not found: "${at}" is an array of ${current.length}; "${segment}" is not a valid index`,
        };
      }
      current = current[index];
    } else if (current !== null && typeof current === "object") {
      if (!Object.hasOwn(current, segment)) {
        return { ok: false, error: `path "${path}" not found: no key "${segment}" under "${at}"` };
      }
      current = (current as Record<string, unknown>)[segment];
    } else {
      return {
        ok: false,
        error: `path "${path}" not found: "${at}" is a ${kvViewType(current)}, it has no "${segment}"`,
      };
    }
  }
  return { ok: true, value: current };
}

/** The value at `path` ("" = whole value) inside a stored KV value. */
export function resolveKvTarget(
  value: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const { root, json } = kvViewRoot(value);
  if (path !== "" && !json) {
    return {
      ok: false,
      error: `path "${path}" needs a JSON value; this entry is a plain string (use offset/limit alone to page its characters)`,
    };
  }
  return resolvePath(root, path);
}

/** Window `[offset, offset + limit)` over a target's items, keys, or characters. */
export function sliceKvTarget(
  target: unknown,
  offset: number,
  limit: number | undefined,
): { value: unknown; total: number; returned: number; nextOffset: number | null } | undefined {
  const total = itemCount(target);
  if (total === undefined) return undefined;
  const start = Math.min(offset, total);
  const end = limit === undefined ? total : Math.min(total, start + limit);
  let value: unknown;
  let returned = end - start;
  if (Array.isArray(target)) {
    value = target.slice(start, end);
  } else if (typeof target === "string") {
    // Never end a page on a lone high surrogate: back off one char so the next
    // page starts on the pair, or take the whole pair when it is the only char
    // (otherwise `limit: 1` would return nothing and never advance).
    const lastCode = target.charCodeAt(end - 1);
    const splitsPair = end > start && end < total && lastCode >= 0xd800 && lastCode <= 0xdbff;
    const safeEnd = splitsPair ? (end - 1 > start ? end - 1 : end + 1) : end;
    value = target.slice(start, safeEnd);
    returned = safeEnd - start;
  } else {
    value = Object.fromEntries(Object.entries(target as object).slice(start, end));
  }
  const reached = start + returned;
  return { value, total, returned, nextOffset: reached < total ? reached : null };
}

/**
 * Resolve `path`, then apply `offset`/`limit`. Out-of-range offsets return an
 * empty page with the true `total`; missing paths and paths into a plain
 * string are errors. No size cap here: callers that feed a model bound the
 * page themselves (see the kv-get tool).
 */
export function resolveKvView(value: unknown, args: KvViewArgs): KvViewResult {
  const path = args.path ?? "";
  const resolved = resolveKvTarget(value, path);
  if (!resolved.ok) return resolved;
  const type = kvViewType(resolved.value);
  const offset = args.offset ?? 0;
  const sliced = sliceKvTarget(resolved.value, offset, args.limit);
  if (!sliced) {
    if (args.offset !== undefined || args.limit !== undefined) {
      return {
        ok: false,
        error: `offset/limit page arrays, objects, and strings; "${path || "(root)"}" is a ${type}`,
      };
    }
    return { ok: true, value: resolved.value, view: { path, type } };
  }
  return {
    ok: true,
    value: sliced.value,
    view: {
      path,
      type,
      total: sliced.total,
      offset,
      returned: sliced.returned,
      nextOffset: sliced.nextOffset,
    },
  };
}

type ShapeNode = KvShapeEntry & { value: unknown; segments: string[]; ancestors: unknown[] };

function shapeEntry(segments: string[], value: unknown, ancestors: unknown[]): ShapeNode {
  const items = itemCount(value);
  return {
    path: joinKvPath(segments),
    type: kvViewType(value),
    bytes: Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
    ...(items !== undefined ? { items } : {}),
    value,
    segments,
    ancestors,
  };
}

function childEntries(node: Pick<ShapeNode, "value" | "segments" | "ancestors">): ShapeNode[] {
  const { value, segments, ancestors } = node;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, child]) =>
    shapeEntry([...segments, key], child, [...ancestors, value]),
  );
}

/**
 * The node itself when kv-get can address it within `budget` (JSON-encoded
 * path bytes, what a path costs on the wire), else its nearest such ancestor.
 * An empty key has no path syntax (`""` is the root and empty segments are
 * rejected), so its parent stands in; the root always fits.
 */
function addressable(node: ShapeNode, budget: number): ShapeNode {
  for (let depth = node.segments.length; depth > 0; depth--) {
    const segments = node.segments.slice(0, depth);
    if (segments.includes("")) continue;
    const path = joinKvPath(segments);
    if (path.length > KV_PATH_MAX_CHARS || pathBytes(path) > budget) continue;
    if (depth === node.segments.length) return node;
    return shapeEntry(segments, node.ancestors[depth], node.ancestors.slice(0, depth));
  }
  return shapeEntry([], node.ancestors[0] ?? node.value, []);
}

/**
 * Bounded outline of a JSON value: its biggest branches by serialized bytes,
 * expanding the dominant object one level at a time so the paths reach where
 * the bulk lives (e.g. `outcome.data.data.result.rows`). Arrays are reported
 * with their length and never expanded.
 */
export function summarizeKvShape(
  root: unknown,
  maxEntries = 8,
  maxPathBytes = KV_SHAPE_PATH_BUDGET_BYTES,
): KvShapeEntry[] {
  const rootBytes = Buffer.byteLength(JSON.stringify(root) ?? "", "utf8");
  let entries = childEntries({ value: root, segments: [], ancestors: [] });
  for (let step = 0; step < 8; step++) {
    const candidate = entries
      .filter((entry) => entry.type === "object" && (entry.items ?? 0) > 0)
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (!candidate || candidate.bytes * 4 < rootBytes) break;
    entries = entries.filter((entry) => entry !== candidate).concat(childEntries(candidate));
  }
  // Skip crumbs (under 1% of the value) so the slots go to where the bulk is.
  const sorted = entries.sort((a, b) => b.bytes - a.bytes);
  const significant = sorted.filter((entry) => entry.bytes * 100 >= rootBytes);
  // Paths stay exact so each one works as a kv-get `path`. The summary is
  // bounded by total path bytes: a path that does not fit the remaining budget
  // gives way to its nearest ancestor that does.
  const shape: KvShapeEntry[] = [];
  let budget = maxPathBytes;
  for (const entry of significant.length > 0 ? significant : sorted) {
    if (shape.length >= maxEntries) break;
    const {
      value: _value,
      segments: _segments,
      ancestors: _ancestors,
      ...node
    } = addressable(entry, budget);
    if (shape.some((seen) => seen.path === node.path)) continue;
    shape.push(node);
    budget -= pathBytes(node.path);
  }
  return shape;
}
