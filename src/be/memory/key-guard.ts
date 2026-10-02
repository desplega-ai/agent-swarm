import { can, type RbacPrincipal } from "@/rbac";
import {
  consolidatedKeyMessage,
  isConsolidatedKey,
  isLongtermKey,
  LONGTERM_ROOT,
  longtermKeyError,
  MEMORY_KEY_MAX_LENGTH,
  MEMORY_KEY_PATTERN,
  MEMORY_KEY_PATTERN_MESSAGE,
} from "./key-paths";

/**
 * The one gate for a key that is about to be written, shared by every ingestion
 * path: `memory-store` and `memory-edit` (MCP) and `POST /api/memory/index`
 * (HTTP). It checks the key's shape, the closed `/longterm` root list, and the
 * `memory.write.consolidated` permission for the lead-only roots.
 *
 * A key is a tier, not a label: under `/longterm` it buys a manual memory's
 * lifecycle and a ranking boost (see `tierSource`). So every route that can put
 * a key on a row must pass through here, including a `sourcePath` that the
 * indexer falls back to as the key.
 */

/** Where a key came from. An explicit key is always held to the path shape; a `sourcePath` only under `/longterm`. */
export type MemoryKeyOrigin = "key" | "sourcePath";

/** Who is writing, in the terms `can()` takes. */
export interface MemoryKeyWriter {
  principal: RbacPrincipal;
  source: "mcp" | "http";
}

/** `invalid`: the key is not an allowed path (HTTP 400). `forbidden`: the writer may not use it (HTTP 403). */
export class MemoryKeyError extends Error {
  constructor(
    message: string,
    readonly reason: "invalid" | "forbidden",
  ) {
    super(message);
    this.name = "MemoryKeyError";
  }
}

/** A writer nobody vouched for: not a lead, so lead-only roots stay closed. */
const NO_AUTHORITY: MemoryKeyWriter = {
  principal: { kind: "agent", agentId: "", isLead: false },
  source: "http",
};

function shapeError(key: string, origin: MemoryKeyOrigin): string | null {
  if (key.length <= MEMORY_KEY_MAX_LENGTH && MEMORY_KEY_PATTERN.test(key)) return null;
  const subject =
    origin === "sourcePath"
      ? `sourcePath "${key}" starts with ${LONGTERM_ROOT}, so it is used as the key, but it is not a valid key.`
      : `Key "${key}" is not a valid key.`;
  return `${subject} ${MEMORY_KEY_PATTERN_MESSAGE}`;
}

/**
 * Throw a `MemoryKeyError` unless `writer` may write a row under `key`.
 *
 * - `origin: "key"`: the key must match the path shape wherever it points.
 * - `origin: "sourcePath"`: a file path stays free-form until it falls under
 *   `/longterm`, where it would act as a curated key, so it gets the same
 *   checks as an explicit one. A path outside `/longterm` confers nothing.
 * - Under `/longterm` the second segment must be an allowed root, and the
 *   lead-only roots need `memory.write.consolidated`. A missing `writer` has
 *   no authority, so it cannot reach them.
 */
export function assertKeyWritable(
  key: string,
  origin: MemoryKeyOrigin,
  writer: MemoryKeyWriter | undefined,
): void {
  if (origin === "sourcePath" && !isLongtermKey(key)) return;

  const shape = shapeError(key, origin);
  if (shape) throw new MemoryKeyError(shape, "invalid");

  const pathError = longtermKeyError(key);
  if (pathError) throw new MemoryKeyError(pathError, "invalid");

  if (!isConsolidatedKey(key)) return;
  const { principal, source } = writer ?? NO_AUTHORITY;
  const decision = can({
    principal,
    verb: "memory.write.consolidated",
    resource: { kind: "none" },
    source,
  });
  if (!decision.allow) throw new MemoryKeyError(consolidatedKeyMessage(key), "forbidden");
}
