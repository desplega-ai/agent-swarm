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
  runId: z
    .string()
    .optional()
    .describe(
      "Workflow run ID — enables the per-delta idempotency receipts that make retries safe",
    ),
  agentIds: z
    .array(z.string())
    .optional()
    .describe(
      "Roster of agent IDs gathered for this run — agent-targeted deltas outside it are held",
    ),
});

const IDEMPOTENCY_NAMESPACE = "dreaming";
const IDEMPOTENCY_TTL_SEC = 7 * 24 * 60 * 60;

/** Deterministic serialization so the idempotency key survives key-order differences. */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, nested]) => nested !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, nested]) => `${JSON.stringify(key)}:${stableStringify(nested)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

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

async function contentHash(content: unknown, normalizeProfileText = false): Promise<string> {
  let serialized: string;
  if (typeof content === "string") {
    serialized = normalizeProfileText ? content.trim() : content;
  } else {
    try {
      serialized = JSON.stringify(content) ?? String(content ?? "");
    } catch {
      serialized = String(content ?? "");
    }
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(serialized),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function auditEntry(delta: unknown, heldReason?: string): Promise<Record<string, unknown>> {
  const value =
    typeof delta === "object" && delta !== null && !Array.isArray(delta)
      ? (delta as Record<string, unknown>)
      : {};
  const kind = typeof value.kind === "string" ? value.kind : "invalid";
  const reason = heldReason ?? (typeof value.reason === "string" ? value.reason : "approved");

  if (kind === "profile-op" || kind === "hygiene") {
    return {
      kind,
      agentId: value.agentId,
      file: kind === "hygiene" ? "HEARTBEAT" : value.file,
      anchor: value.anchor,
      op: value.op,
      // applyAnchoredProfileOp trims inserted text before writing it.
      contentHash: await contentHash(value.content, true),
      reason,
    };
  }

  if (kind === "memory") {
    return withoutUndefined({
      kind,
      agentId: value.agentId,
      action: value.action,
      id: value.id,
      memoryId: value.memoryId,
      key: value.key,
      name: value.name,
      scope: value.scope,
      tags: value.tags,
      ...(typeof value.content === "string"
        ? { contentHash: await contentHash(value.content) }
        : {}),
      reason,
    });
  }

  if (kind === "skill") {
    return withoutUndefined({
      kind,
      action: value.action,
      skillId: value.skillId,
      scope: value.scope,
      ...(typeof value.content === "string"
        ? { contentHash: await contentHash(value.content) }
        : {}),
      reason,
    });
  }

  return withoutUndefined({ kind, agentId: value.agentId, reason });
}

function withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, nested]) => nested !== undefined));
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

/**
 * A per-run, per-delta KV receipt makes retries safe: a crash or timeout after an
 * early delta mutated state re-runs this whole loop, and without the receipt an
 * `append-under` duplicates profile text, a memory write duplicates entries, and a
 * hygiene delta advances its rotation cursor twice. The receipt is written AFTER a
 * delta applies, so the re-apply window shrinks to a crash inside a single delta —
 * exactly-once is not achievable from a sandboxed script without a transactional
 * server-side receipt. Reads fail open (an unreachable KV must not re-apply-block
 * a fresh run); writes fail soft and are noted on the audit entry.
 */
async function alreadyApplied(ctx: any, key: string): Promise<boolean> {
  try {
    // kv_getOrNull returns the KV entry itself (the SDK's kv route serves the
    // REST body directly, NOT the MCP tool's { entry } wrapper) or null on miss.
    const entry = await ctx.swarm.kv_getOrNull({ key, namespace: IDEMPOTENCY_NAMESPACE });
    return entry != null;
  } catch {
    return false;
  }
}

async function markApplied(ctx: any, key: string, entry: Record<string, unknown>): Promise<void> {
  try {
    const written = await ctx.swarm.kv_set({
      key,
      value: "applied",
      namespace: IDEMPOTENCY_NAMESPACE,
      expiresInSec: IDEMPOTENCY_TTL_SEC,
    });
    assertSucceeded(written, "idempotency receipt write");
  } catch (error) {
    entry.receiptError = errorMessage(error);
  }
}

/** Apply an approved dream delta set; this is Dreaming's sole state mutator. */
export default async function dreamApply(args: any, ctx: any) {
  const parsed = argsSchema.safeParse(args);
  if (!parsed.success) throw new Error(`invalid args: ${parsed.error.message}`);
  const deltas = normalizeDeltas(parsed.data.deltas);
  if (!deltas) {
    throw new Error("invalid args: deltas must be an array or an approved delta set");
  }
  const runId = parsed.data.runId;
  const roster = parsed.data.agentIds ? new Set(parsed.data.agentIds) : null;
  const result: {
    applied: Record<string, unknown>[];
    held: Record<string, unknown>[];
    deferred: Array<{ delta: ReflectionDelta; reason: string }>;
  } = { applied: [], held: [], deferred: [] };

  for (const candidate of deltas) {
    const validationError = validateReflectionDelta(candidate);
    if (validationError) {
      result.held.push(await auditEntry(candidate, validationError));
      continue;
    }
    const delta = candidate as ReflectionDelta;
    // The critique's delta text is model-authored and update-profile lets the
    // Lead edit ANY agent — a hallucinated or injected agentId would mutate an
    // agent no evidence was ever gathered for. When the workflow supplies the
    // gathered roster, every agent-targeted delta must name one of its members.
    if (roster && "agentId" in delta && !roster.has(delta.agentId)) {
      result.held.push(
        await auditEntry(delta, `agent ${delta.agentId} is not in this run's gathered roster`),
      );
      continue;
    }
    const idempotencyKey = runId
      ? `apply:${runId}:${await contentHash(stableStringify(delta))}`
      : null;
    if (idempotencyKey && (await alreadyApplied(ctx, idempotencyKey))) {
      // A previous attempt of this run already applied this exact delta.
      result.applied.push({ ...(await auditEntry(delta)), idempotentSkip: true });
      continue;
    }
    try {
      if (delta.kind === "profile-op" || delta.kind === "hygiene") {
        const profileResult = await applyProfileDelta(delta, ctx);
        if (!profileResult.applied) {
          result.held.push(await auditEntry(delta, profileResult.reason));
          continue;
        }
        const entry = await auditEntry(delta);
        if (delta.kind === "hygiene" && delta.rotationCursorKey) {
          // Belt to the validator: without the namespace, kv_incr silently falls
          // back to the CALLER's agent namespace and the shared cursor never moves.
          const cursorNamespace = delta.rotationCursorNamespace;
          if (!cursorNamespace) {
            entry.cursorError = "rotationCursorNamespace missing — cursor not advanced";
          } else {
            // One retry, then surface: KV offers no cross-mutation transaction, so a
            // persistently failing advance is reported on the receipt (the worst
            // case is a repeat review of the same PR, never a silent stall).
            let cursorFailure: string | undefined;
            for (let attempt = 0; attempt < 2; attempt++) {
              try {
                const increment = await ctx.swarm.kv_incr({
                  key: delta.rotationCursorKey,
                  namespace: cursorNamespace,
                  by: delta.rotationCursorBy ?? 1,
                });
                assertSucceeded(increment, "rotation cursor advance");
                cursorFailure = undefined;
                break;
              } catch (error) {
                cursorFailure = errorMessage(error);
              }
            }
            if (cursorFailure) entry.cursorError = cursorFailure;
          }
        }
        if (idempotencyKey) await markApplied(ctx, idempotencyKey, entry);
        result.applied.push(entry);
        continue;
      }

      if (delta.kind === "memory") {
        if (delta.action === "delete") {
          const memoryId = delta.id ?? delta.memoryId;
          // memory_delete is an unscoped by-ID admin endpoint — an approved delta
          // whose agentId and memory ID disagree (hallucinated or cross-lane) would
          // delete ANOTHER agent's memory while the receipt attributes it to the
          // declared agent. Verify ownership first; anything unverifiable is held.
          const ownerResponse = await ctx.swarm.db_query({
            sql: "SELECT agentId FROM agent_memory WHERE id = ?",
            params: [memoryId],
          });
          assertSucceeded(ownerResponse, "memory owner check");
          const owner = firstCell(ownerResponse);
          if (owner === undefined) {
            result.held.push(await auditEntry(delta, `memory ${memoryId} was not found`));
            continue;
          }
          if (owner !== delta.agentId) {
            result.held.push(
              await auditEntry(
                delta,
                `memory ${memoryId} belongs to agent ${owner ?? "(none)"}, not the declared agent`,
              ),
            );
            continue;
          }
          const deleted = await ctx.swarm.memory_delete({ id: memoryId });
          assertSucceeded(deleted, "memory delete");
        } else {
          const written = await ctx.swarm.inject_learning({
            agentId: delta.agentId,
            learning: delta.content,
            category: "best-practice",
          });
          assertSucceeded(written, "memory write");
        }
        const memoryEntry = await auditEntry(delta);
        if (idempotencyKey) await markApplied(ctx, idempotencyKey, memoryEntry);
        result.applied.push(memoryEntry);
        continue;
      }

      if (delta.action === "create") {
        // skill-create defaults an omitted scope to "agent", which would bind the
        // skill to the Lead running this script rather than the swarm catalog —
        // Dreaming skills are always shared (the validator holds anything else).
        const created = await ctx.swarm.skill_create({ content: delta.content, scope: "swarm" });
        assertSucceeded(created, "skill create");
      } else {
        // skill-update lets the Lead edit any owner's skill — a stale or
        // hallucinated skillId could silently rewrite an agent-personal skill
        // that was never in the swarm catalog the critique reviewed. Only
        // already-swarm-scoped targets are updatable.
        const scopeResponse = await ctx.swarm.db_query({
          sql: "SELECT scope FROM skills WHERE id = ?",
          params: [delta.skillId],
        });
        assertSucceeded(scopeResponse, "skill scope check");
        const targetScope = firstCell(scopeResponse);
        if (targetScope === undefined) {
          result.held.push(await auditEntry(delta, `skill ${delta.skillId} was not found`));
          continue;
        }
        if (targetScope !== "swarm") {
          result.held.push(
            await auditEntry(
              delta,
              `skill ${delta.skillId} is ${String(targetScope)}-scoped, not part of the swarm catalog`,
            ),
          );
          continue;
        }
        const updated = await ctx.swarm.skill_update({
          skillId: delta.skillId,
          content: delta.content,
          scope: delta.scope,
        });
        assertSucceeded(updated, "skill update");
      }
      const skillEntry = await auditEntry(delta);
      if (idempotencyKey) await markApplied(ctx, idempotencyKey, skillEntry);
      result.applied.push(skillEntry);
    } catch (error) {
      result.deferred.push({
        delta,
        reason: errorMessage(error),
      });
    }
  }
  return result;
}
