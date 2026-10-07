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

function resolvePath(
  root: unknown,
  path: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (path === "") return { ok: true, value: root };
  const segments = path.split(".");
  if (segments.some((segment) => segment === "")) {
    return {
      ok: false,
      error: `path "${path}" has an empty segment; use dot paths like "data.rows"`,
    };
  }
  let current = root;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] as string;
    const at = segments.slice(0, i).join(".") || "(root)";
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
    // Never end a page on a lone high surrogate; the next page starts there.
    const lastCode = target.charCodeAt(end - 1);
    const safeEnd = end < total && lastCode >= 0xd800 && lastCode <= 0xdbff ? end - 1 : end;
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

function shapeEntry(path: string, value: unknown): KvShapeEntry & { value: unknown } {
  const items = itemCount(value);
  return {
    path,
    type: kvViewType(value),
    bytes: Buffer.byteLength(JSON.stringify(value) ?? "", "utf8"),
    ...(items !== undefined ? { items } : {}),
    value,
  };
}

function childEntries(value: unknown, path: string): Array<KvShapeEntry & { value: unknown }> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, child]) =>
    shapeEntry(path ? `${path}.${key}` : key, child),
  );
}

/**
 * Bounded outline of a JSON value: its biggest branches by serialized bytes,
 * expanding the dominant object one level at a time so the paths reach where
 * the bulk lives (e.g. `outcome.data.data.result.rows`). Arrays are reported
 * with their length and never expanded.
 */
export function summarizeKvShape(root: unknown, maxEntries = 8): KvShapeEntry[] {
  const rootBytes = Buffer.byteLength(JSON.stringify(root) ?? "", "utf8");
  let entries = childEntries(root, "");
  for (let step = 0; step < 8; step++) {
    const candidate = entries
      .filter((entry) => entry.type === "object" && (entry.items ?? 0) > 0)
      .sort((a, b) => b.bytes - a.bytes)[0];
    if (!candidate || candidate.bytes * 4 < rootBytes) break;
    entries = entries
      .filter((entry) => entry !== candidate)
      .concat(childEntries(candidate.value, candidate.path));
  }
  // Skip crumbs (under 1% of the value) so the slots go to where the bulk is.
  const sorted = entries.sort((a, b) => b.bytes - a.bytes);
  const significant = sorted.filter((entry) => entry.bytes * 100 >= rootBytes);
  return (significant.length > 0 ? significant : sorted)
    .slice(0, maxEntries)
    .map(({ value: _value, ...entry }) => ({ ...entry, path: entry.path.slice(0, 160) }));
}
