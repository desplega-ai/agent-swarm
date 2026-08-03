import { z } from "zod";
import {
  applyAnchoredProfileOp,
  type HygieneDelta,
  type ProfileFile,
  type ProfileOpDelta,
  type ReflectionDelta,
  validateReflectionDelta,
} from "../dream-schemas";

export const argsSchema = z.object({
  deltas: z.unknown().describe("Approved delta set produced by the dream critique"),
});

const PROFILE_FIELDS: Record<ProfileFile, string> = {
  SOUL: "soulMd",
  IDENTITY: "identityMd",
  CLAUDE: "claudeMd",
  TOOLS: "toolsMd",
  HEARTBEAT: "heartbeatMd",
};

function firstCell(response: any): unknown {
  const payload = response?.data ?? response;
  return payload?.rows?.[0]?.[0];
}

function assertSucceeded(response: any, action: string): void {
  const payload = response?.data ?? response;
  if (response?.success === false || payload?.success === false) {
    throw new Error(`${action} failed: ${payload?.error ?? response?.error ?? "unknown error"}`);
  }
}

async function applyProfileDelta(delta: ProfileOpDelta | HygieneDelta, ctx: any) {
  const file: ProfileFile = delta.kind === "hygiene" ? "HEARTBEAT" : delta.file;
  const field = PROFILE_FIELDS[file];
  const response = await ctx.swarm.db_query({
    sql: `SELECT ${field} FROM agents WHERE id = ?`,
    params: [delta.agentId],
  });
  assertSucceeded(response, "profile read");
  const current = firstCell(response);
  if (typeof current !== "string") return { applied: false as const, reason: `profile field ${file} not found` };
  const splice = applyAnchoredProfileOp(current, { ...delta, file });
  if (!splice.applied) return splice;
  const update = await ctx.swarm.profile_update({
    agentId: delta.agentId,
    [field]: splice.text,
  });
  assertSucceeded(update, "profile update");
  return { applied: true as const };
}

function appliedEntry(delta: ReflectionDelta): Record<string, unknown> {
  return { kind: delta.kind, agentId: "agentId" in delta ? delta.agentId : undefined, reason: delta.reason };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeDeltas(value: unknown): unknown[] | null {
  if (Array.isArray(value)) return value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const nested = (value as Record<string, unknown>).deltas;
  return Array.isArray(nested) ? nested : null;
}

/** Apply an approved dream delta set; this is Dreaming's sole state mutator. */
export default async function dreamApply(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid args: ${parsed.error.message}`);
  const deltas = normalizeDeltas(parsed.data.deltas);
  if (!deltas) {
    throw new Error("invalid args: deltas must be an array or an approved delta set");
  }
  const result: {
    applied: Record<string, unknown>[];
    held: Array<{ delta: unknown; reason: string }>;
    deferred: Array<{ delta: ReflectionDelta; reason: string }>;
  } = { applied: [], held: [], deferred: [] };

  for (const candidate of deltas) {
    const validationError = validateReflectionDelta(candidate);
    if (validationError) {
      result.held.push({ delta: candidate, reason: validationError });
      continue;
    }
    const delta = candidate as ReflectionDelta;
    try {
      if (delta.kind === "profile-op" || delta.kind === "hygiene") {
        const profileResult = await applyProfileDelta(delta, ctx);
        if (!profileResult.applied) {
          result.held.push({ delta, reason: profileResult.reason });
          continue;
        }
        const entry = appliedEntry(delta);
        if (delta.kind === "hygiene" && delta.rotationCursorKey) {
          try {
            const increment = await ctx.swarm.kv_incr({
              key: delta.rotationCursorKey,
              namespace: delta.rotationCursorNamespace,
              by: delta.rotationCursorBy ?? 1,
            });
            assertSucceeded(increment, "rotation cursor advance");
          } catch (error) {
            entry.cursorError = errorMessage(error);
          }
        }
        result.applied.push(entry);
        continue;
      }

      if (delta.kind === "memory") {
        if (delta.action === "delete") {
          const deleted = await ctx.swarm.memory_delete({ id: delta.id ?? delta.memoryId });
          assertSucceeded(deleted, "memory delete");
        } else {
          const written = await ctx.swarm.inject_learning({
            agentId: delta.agentId,
            learning: delta.content,
            category: "best-practice",
          });
          assertSucceeded(written, "memory write");
        }
        result.applied.push(appliedEntry(delta));
        continue;
      }

      if (delta.action === "create") {
        const created = await ctx.swarm.skill_create({ content: delta.content, scope: delta.scope });
        assertSucceeded(created, "skill create");
      } else {
        const updated = await ctx.swarm.skill_update({
          skillId: delta.skillId,
          content: delta.content,
          scope: delta.scope,
        });
        assertSucceeded(updated, "skill update");
      }
      result.applied.push(appliedEntry(delta));
    } catch (error) {
      result.deferred.push({
        delta,
        reason: errorMessage(error),
      });
    }
  }
  return result;
}
