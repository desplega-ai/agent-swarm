import { openSealedJson } from "./sealed-json";

/**
 * Which copy of a workflow payload a reader gets.
 *
 * - `replay`: the exact value from the sealed `*_replay` column. Resume, retry,
 *   dedup and recovery rebuild the live ctx from it, so a downstream consumer
 *   sees the same bytes after a restart as in the uninterrupted run.
 * - `display`: the scrubbed column, for API responses, MCP tools and the UI.
 */
export type WorkflowPayloadView = "replay" | "display";

/**
 * A sealed replay copy exists but cannot be opened (missing or rotated
 * encryption key, corrupt ciphertext). The scrubbed copy holds redaction
 * markers, so replaying it would silently feed them to downstream nodes: the
 * run fails with this error instead.
 */
export class WorkflowReplayStateError extends Error {
  constructor(
    readonly runId: string,
    readonly target: string,
    cause: unknown,
  ) {
    super(
      `Workflow run ${runId} cannot replay ${target}: its sealed replay copy could not be opened (${
        cause instanceof Error ? cause.message : String(cause)
      }). The redacted copy is never replayed. Restore the SECRETS_ENCRYPTION_KEY that sealed it, then retry the run.`,
    );
    this.name = "WorkflowReplayStateError";
  }
}

/**
 * Set `target[key]` from a workflow payload pair.
 *
 * `display` parses the scrubbed column. `replay` opens the sealed column
 * lazily, on first read of the property: status-only readers (cancel, polls,
 * cooldown) never decrypt and keep working without the key. Rows written before
 * the replay columns existed have no sealed copy and fall back to the plain
 * column.
 */
export function defineWorkflowPayload<T extends object>(
  target: T,
  key: keyof T & string,
  plain: string | null | undefined,
  sealed: string | null | undefined,
  view: WorkflowPayloadView,
  where: { runId: string; target: string },
): T {
  if (view === "display" || !sealed) {
    (target as Record<string, unknown>)[key] = plain ? JSON.parse(plain) : undefined;
    return target;
  }
  let opened = false;
  let value: unknown;
  Object.defineProperty(target, key, {
    enumerable: true,
    configurable: true,
    get() {
      if (!opened) {
        try {
          value = openSealedJson(sealed);
        } catch (err) {
          throw new WorkflowReplayStateError(where.runId, where.target, err);
        }
        opened = true;
      }
      return value;
    },
    set(next: unknown) {
      value = next;
      opened = true;
    },
  });
  return target;
}
