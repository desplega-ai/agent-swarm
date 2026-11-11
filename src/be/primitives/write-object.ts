import { FilesError } from "@/fs/provider";
import {
  clientFor,
  getObject,
  ObjectsError,
  PRIMITIVE_KINDS,
  type PrimitiveObject,
  recordObjectVersion,
} from "./objects";

type Json = Record<string, unknown>;

export const MAX_OBJECT_BYTES = 5 * 1024 * 1024;
/** One write plus three re-read-and-reapply rounds on a 409. */
export const MAX_WRITE_ATTEMPTS = 4;

/**
 * Read an object's file with its agent-fs version, apply `mutate`, and write it
 * back with `If-Match`. On a 409 it re-reads and re-applies, so patches to
 * different parts merge and the same part is last writer wins. The write also
 * re-embeds `swarm.id`, which heals a stock editor save that dropped it.
 */
export async function mutateObject<T>(input: {
  agentId: string | undefined;
  id?: string;
  path?: string;
  kind: string;
  /** agent-fs commit message. */
  message: string;
  mutate: (content: Json, object: PrimitiveObject) => T;
}): Promise<{ object: PrimitiveObject; version: number | null; result: T }> {
  const kind = PRIMITIVE_KINDS[input.kind];
  if (!kind) throw new ObjectsError(`unknown kind '${input.kind}'`);
  const { provider, scope } = await clientFor(input.agentId);
  for (let attempt = 1; ; attempt += 1) {
    const { object, missing, content } = await getObject({
      agentId: input.agentId,
      id: input.id,
      path: input.path,
      includeContent: true,
    });
    if (object.kind !== input.kind) {
      throw new ObjectsError(`object ${object.id} is a ${object.kind}, not a ${input.kind}`);
    }
    if (missing) {
      throw new ObjectsError(
        `the file for ${object.kind} ${object.id} at '${object.path}' is missing; run object-reindex`,
      );
    }
    if (!content || typeof content !== "object" || Array.isArray(content)) {
      throw new ObjectsError(`'${object.path}' is not a JSON object`);
    }
    if (object.fileVersion === null) {
      throw new ObjectsError(
        `agent-fs returned no version for '${object.path}'; refusing an unguarded write`,
      );
    }
    const result = input.mutate(content as Json, object);
    const body = JSON.stringify(kind.withId(content as Json, object.id), null, 2);
    if (Buffer.byteLength(body) > MAX_OBJECT_BYTES) {
      throw new ObjectsError(
        `'${object.path}' would exceed ${MAX_OBJECT_BYTES} bytes; nothing written`,
      );
    }
    try {
      const written = await provider.upload(scope(object.path), body, {
        contentType: kind.contentType,
        ifMatch: String(object.fileVersion),
        message: input.message,
      });
      const version = Number.isFinite(Number(written.version)) ? Number(written.version) : null;
      await recordObjectVersion(object.id, version);
      return { object: { ...object, fileVersion: version }, version, result };
    } catch (error) {
      if (!(error instanceof FilesError && error.code === "Conflict")) throw error;
      if (attempt >= MAX_WRITE_ATTEMPTS) {
        throw new ObjectsError(
          `concurrent writers changed '${object.path}' ${attempt} times in a row; retry`,
        );
      }
    }
  }
}
