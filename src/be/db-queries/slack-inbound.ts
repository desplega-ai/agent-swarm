import { getStorage } from "../storage";

function slackRepo() {
  return getStorage().repos.slack;
}

/**
 * Durable receipt store for inbound Slack deliveries.
 *
 * Admission is one atomic INSERT against a unique dedup key inside a
 * `BEGIN IMMEDIATE` transaction, never a SELECT-then-INSERT or an in-memory map,
 * so concurrent identical deliveries produce exactly one row and one drain job.
 * The caller encrypts the payload; this module never sees plaintext.
 *
 * State machine:
 *   pending ──claim──▶ processing ──▶ processed | ignored | failed | uncertain
 *      ▲                    │
 *      └── release (failure established to precede any side effect)
 *   processing ──(boot recovery after a crash)──▶ uncertain
 *
 * Retention never touches `pending`, `processing` or `uncertain` receipts.
 */

export type SlackInboundTransport = "socket" | "http";
export type SlackInboundKind = "event" | "interaction" | "command";
export type SlackInboundState =
  | "pending"
  | "processing"
  | "processed"
  | "ignored"
  | "failed"
  | "uncertain";

export const SLACK_INBOUND_STATES: readonly SlackInboundState[] = [
  "pending",
  "processing",
  "processed",
  "ignored",
  "failed",
  "uncertain",
];

/**
 * Initial operational bounds. Sized from measured production traffic
 * (2026-08-25 → 2026-09-24, Slack-sourced tasks): peak 4/min, 19/hour, 866 in
 * 30 days, largest task body ~34 KB. Inbound events outnumber tasks (channel
 * chatter that is filtered), so the backlog cap leaves ~50x headroom over the
 * peak hour of task-producing traffic.
 */
export const SLACK_INBOUND_LIMITS = {
  /** Pending + processing receipts before admission answers "overloaded". */
  maxBacklogReceipts: 1_000,
  /** Plaintext bytes held by pending + processing receipts. */
  maxBacklogBytes: 32 * 1024 * 1024,
  /** A single delivery larger than this is refused outright. */
  maxPayloadBytes: 1024 * 1024,
  /** How long a completed dedup key is kept (covers Slack's retry schedule). */
  completedRetentionMs: 48 * 60 * 60 * 1000,
  /** Claims before a failure that preceded side effects becomes terminal. */
  maxAttempts: 3,
  /** Delay before a released receipt can be claimed again, per attempt. */
  retryBackoffMs: 30_000,
} as const;

export type SlackInboundLimits = typeof SLACK_INBOUND_LIMITS;

export interface SlackInboundReceipt {
  id: string;
  dedupKey: string;
  transport: SlackInboundTransport;
  kind: SlackInboundKind;
  payloadType: string;
  apiAppId: string | null;
  eventId: string | null;
  payloadCiphertext: string | null;
  payloadBytes: number;
  retryNum: number | null;
  retryReason: string | null;
  state: SlackInboundState;
  attempts: number;
  duplicateCount: number;
  outcomeCode: string | null;
  errorCode: string | null;
  receivedAt: string;
  availableAt: string;
  claimedAt: string | null;
  completedAt: string | null;
  lastDuplicateAt: string | null;
  payloadErasedAt: string | null;
}

interface SlackInboundReceiptRow {
  id: string;
  dedup_key: string;
  transport: SlackInboundTransport;
  kind: SlackInboundKind;
  payload_type: string;
  api_app_id: string | null;
  event_id: string | null;
  payload_ciphertext: string | null;
  payload_bytes: number;
  retry_num: number | null;
  retry_reason: string | null;
  state: SlackInboundState;
  attempts: number;
  duplicate_count: number;
  outcome_code: string | null;
  error_code: string | null;
  received_at: string;
  available_at: string;
  claimed_at: string | null;
  completed_at: string | null;
  last_duplicate_at: string | null;
  payload_erased_at: string | null;
}

function toReceipt(row: SlackInboundReceiptRow): SlackInboundReceipt {
  return {
    id: row.id,
    dedupKey: row.dedup_key,
    transport: row.transport,
    kind: row.kind,
    payloadType: row.payload_type,
    apiAppId: row.api_app_id,
    eventId: row.event_id,
    payloadCiphertext: row.payload_ciphertext,
    payloadBytes: row.payload_bytes,
    retryNum: row.retry_num,
    retryReason: row.retry_reason,
    state: row.state,
    attempts: row.attempts,
    duplicateCount: row.duplicate_count,
    outcomeCode: row.outcome_code,
    errorCode: row.error_code,
    receivedAt: row.received_at,
    availableAt: row.available_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
    lastDuplicateAt: row.last_duplicate_at,
    payloadErasedAt: row.payload_erased_at,
  };
}

export interface AdmitSlackInboundReceiptInput {
  dedupKey: string;
  transport: SlackInboundTransport;
  kind: SlackInboundKind;
  payloadType: string;
  apiAppId?: string | null;
  eventId?: string | null;
  payloadCiphertext: string;
  payloadBytes: number;
  retryNum?: number | null;
  retryReason?: string | null;
}

export type SlackInboundAdmission =
  | { status: "admitted"; receipt: SlackInboundReceipt }
  | { status: "duplicate"; receipt: SlackInboundReceipt }
  | { status: "rejected"; reason: "payload_too_large" | "backlog_full" };

/**
 * Admit a delivery. A duplicate of a stored key is always acknowledged, even
 * under overload: it needs no new work. A new key is refused when the backlog
 * is full so the transport can answer 503 and Slack retries later.
 */
export async function admitSlackInboundReceipt(
  input: AdmitSlackInboundReceiptInput,
  now: Date = new Date(),
  limits: Pick<
    SlackInboundLimits,
    "maxBacklogReceipts" | "maxBacklogBytes" | "maxPayloadBytes"
  > = SLACK_INBOUND_LIMITS,
): Promise<SlackInboundAdmission> {
  const nowIso = now.toISOString();
  const repo = slackRepo();
  return getStorage().transaction(async (): Promise<SlackInboundAdmission> => {
    const duplicate = (await repo.touchInboundDuplicate(
      input.dedupKey,
      nowIso,
    )) as SlackInboundReceiptRow | null;
    if (duplicate) return { status: "duplicate", receipt: toReceipt(duplicate) };

    if (input.payloadBytes > limits.maxPayloadBytes) {
      return { status: "rejected", reason: "payload_too_large" };
    }

    const { receipts, bytes } = await repo.inboundBacklog();
    if (
      receipts >= limits.maxBacklogReceipts ||
      bytes + input.payloadBytes > limits.maxBacklogBytes
    ) {
      return { status: "rejected", reason: "backlog_full" };
    }

    const inserted = (await repo.insertInboundReceipt({
      id: crypto.randomUUID(),
      dedupKey: input.dedupKey,
      transport: input.transport,
      kind: input.kind,
      payloadType: input.payloadType,
      apiAppId: input.apiAppId ?? null,
      eventId: input.eventId ?? null,
      payloadCiphertext: input.payloadCiphertext,
      payloadBytes: input.payloadBytes,
      retryNum: input.retryNum ?? null,
      retryReason: input.retryReason ?? null,
      now: nowIso,
    })) as SlackInboundReceiptRow | null;
    if (inserted) return { status: "admitted", receipt: toReceipt(inserted) };

    // Unreachable under BEGIN IMMEDIATE, kept so a future deferred caller still
    // reports the winner instead of a phantom admission.
    const winner = (await repo.findInboundReceiptByKey(
      input.dedupKey,
    )) as SlackInboundReceiptRow | null;
    if (!winner) throw new Error("Slack inbound receipt vanished during admission");
    return { status: "duplicate", receipt: toReceipt(winner) };
  });
}

export interface RecordSlackInboundInlineInput {
  dedupKey: string;
  transport: SlackInboundTransport;
  kind: SlackInboundKind;
  payloadType: string;
  apiAppId?: string | null;
  eventId?: string | null;
  retryNum?: number | null;
  retryReason?: string | null;
}

/**
 * Remember the dedup key of a delivery that is about to run outside the drain.
 *
 * The row is a tombstone: terminal (`processed`), no payload, never claimable.
 * Retention drops it with the other completed keys, after the window in which
 * Slack still redelivers. It exists so a redelivery is dropped after a restart,
 * when the in-memory `event_id` cache is gone. The key is written before the
 * work runs, so a crash mid-run is never replayed, as for an `uncertain`
 * receipt. Returns `duplicate` when the key was already stored, counting the
 * sighting.
 */
export async function recordSlackInboundInline(
  input: RecordSlackInboundInlineInput,
  now: Date = new Date(),
): Promise<"recorded" | "duplicate"> {
  const nowIso = now.toISOString();
  const inserted = await slackRepo().insertInboundTombstone({
    id: crypto.randomUUID(),
    dedupKey: input.dedupKey,
    transport: input.transport,
    kind: input.kind,
    payloadType: input.payloadType,
    apiAppId: input.apiAppId ?? null,
    eventId: input.eventId ?? null,
    retryNum: input.retryNum ?? null,
    retryReason: input.retryReason ?? null,
    now: nowIso,
  });
  if (inserted) return "recorded";
  await touchSlackInboundDuplicate(input.dedupKey, now);
  return "duplicate";
}

/**
 * Is this key stored? Counts the sighting as a duplicate delivery when it is.
 * One atomic UPDATE, no read-then-write.
 */
export async function touchSlackInboundDuplicate(
  dedupKey: string,
  now: Date = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const row = await slackRepo().touchInboundDuplicate(dedupKey, nowIso);
  return row !== null && row !== undefined;
}

/**
 * Atomically move one claimable pending receipt to `processing`. Without an id
 * the oldest available receipt is claimed. Returns null when nothing is
 * claimable (or the named receipt was claimed by someone else).
 */
export async function claimSlackInboundReceipt(
  now: Date = new Date(),
  id?: string,
): Promise<SlackInboundReceipt | null> {
  const nowIso = now.toISOString();
  const row = (await slackRepo().claimInboundReceipt(nowIso, id)) as SlackInboundReceiptRow | null;
  return row ? toReceipt(row) : null;
}

export type SlackInboundTerminalState = "processed" | "ignored" | "failed" | "uncertain";

/**
 * Record the outcome of a claimed receipt. Processed and ignored receipts
 * erase their payload immediately; failed and uncertain ones keep it for
 * operator review. Only a receipt still in `processing` is updated.
 */
export async function completeSlackInboundReceipt(
  id: string,
  outcome: {
    state: SlackInboundTerminalState;
    outcomeCode?: string | null;
    errorCode?: string | null;
  },
  now: Date = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  const erase = outcome.state === "processed" || outcome.state === "ignored";
  return slackRepo().completeInboundReceipt(
    id,
    {
      state: outcome.state,
      outcomeCode: outcome.outcomeCode ?? null,
      errorCode: outcome.errorCode ?? null,
      completedAt: outcome.state === "uncertain" ? null : nowIso,
      erasePayload: erase,
    },
    nowIso,
  );
}

/**
 * Return a claimed receipt to `pending` after a failure established to precede
 * any side effect. It becomes claimable again at `availableAt`.
 */
export async function releaseSlackInboundReceipt(
  id: string,
  errorCode: string,
  availableAt: Date,
  now: Date = new Date(),
): Promise<boolean> {
  const nowIso = now.toISOString();
  return slackRepo().releaseInboundReceipt(id, errorCode, availableAt.toISOString(), nowIso);
}

/** Earliest `available_at` among pending receipts, or null when none wait. */
export async function getNextSlackInboundAvailableAt(): Promise<Date | null> {
  const next = await slackRepo().nextInboundAvailableAt();
  return next ? new Date(next) : null;
}

/**
 * Boot recovery: a receipt still `processing` belonged to a process that died
 * mid-handler. Its side effects are unknown, so it becomes `uncertain` and is
 * never replayed automatically. Call before the drain starts.
 */
export async function markInterruptedSlackInboundReceiptsUncertain(
  now: Date = new Date(),
): Promise<number> {
  const nowIso = now.toISOString();
  return slackRepo().markInterruptedInboundUncertain(nowIso);
}

/**
 * Retention: erase any payload a completed receipt still holds, and delete
 * completed receipts (with their dedup key) once the retention window passes.
 * Pending, processing and uncertain receipts are never touched.
 */
export async function purgeSlackInboundReceipts(
  now: Date = new Date(),
  retentionMs: number = SLACK_INBOUND_LIMITS.completedRetentionMs,
): Promise<{ erasedPayloads: number; deletedReceipts: number }> {
  const nowIso = now.toISOString();
  const cutoff = new Date(now.getTime() - retentionMs).toISOString();
  const repo = slackRepo();
  return getStorage().transaction(async () => {
    const deletedReceipts = await repo.deleteCompletedInboundBefore(cutoff);
    const erasedPayloads = await repo.eraseCompletedInboundPayloads(nowIso);
    return { erasedPayloads, deletedReceipts };
  });
}

export async function getSlackInboundReceiptById(id: string): Promise<SlackInboundReceipt | null> {
  const row = (await slackRepo().findInboundReceipt(id)) as SlackInboundReceiptRow | null;
  return row ? toReceipt(row) : null;
}

export async function getSlackInboundReceiptByKey(
  dedupKey: string,
): Promise<SlackInboundReceipt | null> {
  const row = (await slackRepo().findInboundReceiptByKey(
    dedupKey,
  )) as SlackInboundReceiptRow | null;
  return row ? toReceipt(row) : null;
}

export interface SlackInboundReceiptStats {
  counts: Record<SlackInboundState, number>;
  backlogBytes: number;
  duplicateDeliveries: number;
  oldestPendingReceivedAt: string | null;
  oldestUncertainReceivedAt: string | null;
  lastReceivedAt: string | null;
  lastFailure: { errorCode: string | null; at: string } | null;
  /** Uncertain receipts, newest first, for operator review. No payloads. */
  uncertain: Array<{
    id: string;
    kind: SlackInboundKind;
    payloadType: string;
    eventId: string | null;
    errorCode: string | null;
    receivedAt: string;
    attempts: number;
  }>;
}

export async function getSlackInboundReceiptStats(
  uncertainLimit = 20,
): Promise<SlackInboundReceiptStats> {
  const repo = slackRepo();
  return getStorage().transaction(
    async () => {
      const counts = Object.fromEntries(SLACK_INBOUND_STATES.map((s) => [s, 0])) as Record<
        SlackInboundState,
        number
      >;
      const byState = (await repo.inboundStateCounts()) as {
        state: SlackInboundState;
        n: number;
        oldest: string;
      }[];
      let oldestPending: string | null = null;
      let oldestUncertain: string | null = null;
      for (const row of byState) {
        counts[row.state] = row.n;
        if (row.state === "pending") oldestPending = row.oldest;
        if (row.state === "uncertain") oldestUncertain = row.oldest;
      }
      const totals = await repo.inboundTotals();
      const lastFailure = await repo.lastInboundFailure();
      const uncertain = (await repo.listUncertainInbound(
        uncertainLimit,
      )) as SlackInboundReceiptRow[];
      return {
        counts,
        backlogBytes: totals?.backlogBytes ?? 0,
        duplicateDeliveries: totals?.duplicates ?? 0,
        oldestPendingReceivedAt: oldestPending,
        oldestUncertainReceivedAt: oldestUncertain,
        lastReceivedAt: totals?.lastReceivedAt ?? null,
        lastFailure: lastFailure
          ? { errorCode: lastFailure.error_code, at: lastFailure.updated_at }
          : null,
        uncertain: uncertain.map((row) => ({
          id: row.id,
          kind: row.kind,
          payloadType: row.payload_type,
          eventId: row.event_id,
          errorCode: row.error_code,
          receivedAt: row.received_at,
          attempts: row.attempts,
        })),
      };
    },
    { readOnly: true },
  );
}
