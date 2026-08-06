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
  rotation: z
    .unknown()
    .optional()
    .describe(
      "Gather's rotation blob — when a target was available this run, the cursor advances even if no hygiene delta carried it",
    ),
  hygieneReview: z
    .unknown()
    .optional()
    .describe(
      "The hygiene lane's raw output — proof the rotation target was actually reviewed; empty when that lane failed under onNodeFailure continue",
    ),
  prSnapshot: z
    .unknown()
    .optional()
    .describe(
      "The gh-pr-snapshot result — the rotation target is only consumed when its snapshot succeeded, so a GitHub outage cannot skip an un-snapshotted pull request",
    ),
});

/**
 * Whether the rotation target's pull-request snapshot actually succeeded.
 *
 * `gh-pr-snapshot` degrades to `{ error }` on a GitHub or network outage rather
 * than failing the run, and the hygiene lane can still return a well-formed
 * `{"deltas": []}` from evidence it never received. Reviewing nothing is not
 * reviewing, so a failed snapshot must not consume the target.
 */
function rotationSnapshotSucceeded(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return false;
    try {
      return rotationSnapshotSucceeded(JSON.parse(text));
    } catch {
      return false;
    }
  }
  if (typeof value !== "object") return false;
  const snapshot = value as Record<string, unknown>;
  return snapshot.error === undefined && snapshot.skipped !== true;
}

/**
 * Whether the hygiene lane produced a review this run.
 *
 * Non-emptiness is NOT the test. Under `onNodeFailure: "continue"` a failed or
 * cancelled lane is checkpointed with a non-empty sentinel output
 * (`"[FAILED: …] This node failed or was cancelled."` — see
 * `src/workflows/resume.ts` and `recovery.ts`), and an unresolved input
 * interpolates to `""`. So this asks for POSITIVE evidence instead: the lane was
 * asked for an ApprovedDeltaSet, and only a value actually shaped like one counts
 * as a review. A quiet day still qualifies — that is `{"deltas": []}`.
 *
 * Deliberately conservative in one direction: an output this fails to recognize
 * only holds the rotation cursor for a day, whereas a false "reviewed" skips a
 * pull request nobody looked at until the cursor wraps all the way around.
 */
function hygieneLaneReviewed(value: unknown): boolean {
  if (typeof value === "string") {
    const text = value.trim();
    if (text.length === 0) return false;
    try {
      return hygieneLaneReviewed(JSON.parse(text));
    } catch {
      return false;
    }
  }
  if (Array.isArray(value)) return true;
  if (typeof value === "object" && value !== null) {
    return Array.isArray((value as Record<string, unknown>).deltas);
  }
  return false;
}

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
  const snapshotSucceeded = rotationSnapshotSucceeded(parsed.data.prSnapshot);
  const result: {
    applied: Record<string, unknown>[];
    held: Record<string, unknown>[];
    deferred: Array<{ delta: ReflectionDelta; reason: string }>;
    rotationCursor?: { advanced: boolean; error?: string; reason?: string; receiptError?: string };
  } = { applied: [], held: [], deferred: [] };
  let cursorAdvancedByDelta = false;

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
      // A previous attempt of this run already applied this exact delta —
      // including its cursor advance, so the run-level fallback must not re-fire.
      if (delta.kind === "hygiene" && delta.rotationCursorKey) cursorAdvancedByDelta = true;
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
        // Same gate as the run-level advance below: a delta may carry cursor
        // coordinates for an unrelated HEARTBEAT edit, and honouring them when
        // the snapshot failed would skip a pull request that was never fetched.
        if (delta.kind === "hygiene" && delta.rotationCursorKey && !snapshotSucceeded) {
          entry.cursorError = "pull-request snapshot did not succeed — cursor not advanced";
        } else if (delta.kind === "hygiene" && delta.rotationCursorKey) {
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
            else cursorAdvancedByDelta = true;
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
            sql: "SELECT agentId, scope FROM agent_memory WHERE id = ?",
            params: [memoryId],
          });
          assertSucceeded(ownerResponse, "memory owner check");
          const ownerRow = ((ownerResponse?.data ?? ownerResponse)?.rows?.[0] ?? []) as unknown[];
          const owner = ownerRow[0];
          const memoryScope = ownerRow[1];
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
          // Dreaming only ever writes swarm-scoped memories, so a delete pointed at
          // an agent-private memory is outside anything the critique reviewed — the
          // owner check alone would still pass for the declared agent's own rows.
          if (memoryScope !== "swarm") {
            result.held.push(
              await auditEntry(
                delta,
                `memory ${memoryId} is ${String(memoryScope ?? "(none)")}-scoped, not a swarm memory Dreaming manages`,
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
            // Provenance: lets dream-agent-slice keep the add-on's own writes out
            // of tomorrow's evidence instead of reflecting on its own output.
            tags: ["dreaming"],
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
          sql: "SELECT scope, systemDefault FROM skills WHERE id = ?",
          params: [delta.skillId],
        });
        assertSucceeded(scopeResponse, "skill scope check");
        const skillRow = ((scopeResponse?.data ?? scopeResponse)?.rows?.[0] ?? []) as unknown[];
        const targetScope = skillRow[0];
        const targetSystemDefault = skillRow[1];
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
        // Seeded skills are system-managed: skill-update rejects content edits on
        // them, and the seeder would re-render the template over any edit that did
        // land. Held here so the reason reads as policy on the receipt instead of
        // arriving as a raw tool error in DEFERRED every night.
        if (targetSystemDefault === 1 || targetSystemDefault === true) {
          result.held.push(
            await auditEntry(
              delta,
              `skill ${delta.skillId} is system-managed (seeded from a repo template) and cannot be edited — propose a new skill or a repo change instead`,
            ),
          );
          continue;
        }
        // skill_update replaces the WHOLE SKILL.md — a delta authored from catalog
        // metadata alone (or a partial diff) would wipe the existing playbook.
        // Require a plausible complete document: frontmatter with a name field.
        const replacement = String(delta.content ?? "");
        if (!replacement.trimStart().startsWith("---") || !/^\s*name\s*:/m.test(replacement)) {
          result.held.push(
            await auditEntry(
              delta,
              "skill update content must be a complete SKILL.md (frontmatter with name + body) — partial content would replace the entire skill",
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

  // Reviewing the rotation target IS consuming it: advance the shared cursor even
  // when the review approved no HEARTBEAT edit, otherwise a clean PR would be
  // reselected every dream and later PRs would never enter the rotation. Skipped
  // when a hygiene delta already advanced it (directly or in a prior attempt).
  const rotation = parsed.data.rotation as
    | { available?: boolean; key?: string; namespace?: string }
    | undefined;
  const reviewed = hygieneLaneReviewed(parsed.data.hygieneReview);
  const notConsumed = !reviewed
    ? "hygiene lane produced no review — rotation target left for the next dream"
    : !snapshotSucceeded
      ? "pull-request snapshot did not succeed — rotation target left for the next dream"
      : null;
  if (rotation?.available === true && !cursorAdvancedByDelta && notConsumed) {
    // Availability alone is not consumption: either the lane that reviews the
    // target failed, or it reviewed without the evidence it needed. Leave the
    // cursor rather than skipping a pull request nobody actually looked at.
    result.rotationCursor = { advanced: false, reason: notConsumed };
  } else if (rotation?.available === true && !cursorAdvancedByDelta) {
    const cursorIdempotencyKey = runId ? `apply:${runId}:rotation-cursor` : null;
    if (cursorIdempotencyKey && (await alreadyApplied(ctx, cursorIdempotencyKey))) {
      result.rotationCursor = { advanced: true };
    } else {
      // Same retry/report posture as the per-delta advance: KV offers no
      // transaction, so a persistent failure is surfaced on the receipt (worst
      // case a repeat review of the same PR, never a silent stall).
      let cursorFailure: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        try {
          const increment = await ctx.swarm.kv_incr({
            key: rotation.key ?? "rotation-cursor",
            namespace: rotation.namespace ?? "dreaming",
            by: 1,
          });
          assertSucceeded(increment, "rotation cursor advance");
          cursorFailure = undefined;
          break;
        } catch (error) {
          cursorFailure = errorMessage(error);
        }
      }
      result.rotationCursor = cursorFailure
        ? { advanced: false, error: cursorFailure }
        : { advanced: true };
      if (!cursorFailure && cursorIdempotencyKey) {
        await markApplied(ctx, cursorIdempotencyKey, result.rotationCursor);
      }
    }
  }

  return result;
}
