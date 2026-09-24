import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import type { AnyMiddlewareArgs, Middleware } from "@slack/bolt";
import { decryptSecret, encryptSecret, getEncryptionKey } from "../be/crypto";
import {
  admitSlackInboundReceipt,
  claimSlackInboundReceipt,
  completeSlackInboundReceipt,
  getSlackInboundReceiptStats,
  markInterruptedSlackInboundReceiptsUncertain,
  releaseSlackInboundReceipt,
  SLACK_INBOUND_LIMITS,
  type SlackInboundAdmission,
  type SlackInboundKind,
  type SlackInboundReceipt,
  type SlackInboundReceiptStats,
  type SlackInboundTransport,
} from "../be/db-queries/slack-inbound";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getSlackConfiguration, type SlackMode } from "./config";

/**
 * Explicit outcomes for inbound Slack deliveries.
 *
 * Handlers report what happened through this module instead of implying
 * success by returning:
 *
 * - `noteSlackInboundSideEffect(label)` BEFORE a durable mutation (task
 *   creation, steering, thread buffering, workflow emission). Marking before is
 *   deliberate: a mutation that throws half way still counts, so its delivery
 *   becomes `uncertain` rather than being replayed into a duplicate task.
 * - `ignoreSlackInbound(reason)` at an expected filter (bot message, edit,
 *   unauthorized user, rate limit, ...).
 * - `reportSlackInboundFailure(code)` where a handler catches an error it does
 *   not rethrow.
 *
 * The resolved outcome is:
 *   error or reported failure, after a side effect → uncertain
 *   error or reported failure, before any side effect → failed (retryable)
 *   an ignore reason → ignored
 *   otherwise → processed
 *
 * Two entry points establish the delivery context:
 * - `slackInboundOutcomeMiddleware()`, the first Bolt global middleware, wraps
 *   every Socket Mode delivery. It only records outcome counters: Socket Mode
 *   ingress, its in-memory event dedup and its error propagation are unchanged.
 * - `runAdmittedSlackDelivery()`, used by the durable drain, marks the delivery
 *   as admitted from a receipt. That trusted, in-process flag (never a body
 *   field) is what lets handlers skip the legacy in-memory `event_id` cache: the
 *   receipt's unique key already deduplicated the delivery.
 */

export type SlackInboundOutcomeState = "processed" | "ignored" | "failed" | "uncertain";

export interface SlackInboundOutcome {
  state: SlackInboundOutcomeState;
  code: string;
}

interface DeliveryState {
  transport: SlackInboundTransport;
  admitted: boolean;
  dispatched: boolean;
  sideEffects: string[];
  ignoredReasons: string[];
  failures: string[];
}

const deliveryStorage = new AsyncLocalStorage<DeliveryState>();

function newDeliveryState(transport: SlackInboundTransport, admitted: boolean): DeliveryState {
  return {
    transport,
    admitted,
    dispatched: false,
    sideEffects: [],
    ignoredReasons: [],
    failures: [],
  };
}

/** Mark a durable mutation about to happen for the current delivery. */
export function noteSlackInboundSideEffect(label: string): void {
  deliveryStorage.getStore()?.sideEffects.push(label);
}

/** Mark the current delivery as intentionally filtered. */
export function ignoreSlackInbound(reason: string): void {
  deliveryStorage.getStore()?.ignoredReasons.push(reason);
}

/** Report an error a handler caught and did not rethrow. */
export function reportSlackInboundFailure(code: string): void {
  deliveryStorage.getStore()?.failures.push(code);
}

/**
 * True only inside a delivery the durable receipt store already admitted. Set
 * by `runAdmittedSlackDelivery`, never derived from the payload.
 */
export function isAdmittedSlackDelivery(): boolean {
  return deliveryStorage.getStore()?.admitted === true;
}

function errorCode(error: unknown): string {
  if (error && typeof error === "object" && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return "handler_error";
}

export function resolveSlackInboundOutcome(
  state: Pick<DeliveryState, "sideEffects" | "ignoredReasons" | "failures">,
  error?: unknown,
): SlackInboundOutcome {
  const threw = error !== undefined;
  if (threw || state.failures.length > 0) {
    const code = state.failures[0] ?? errorCode(error);
    return { state: state.sideEffects.length > 0 ? "uncertain" : "failed", code };
  }
  if (state.ignoredReasons.length > 0) {
    return { state: "ignored", code: state.ignoredReasons[0]! };
  }
  return { state: "processed", code: state.sideEffects[0] ?? "completed" };
}

// ─── Outcome counters (Socket Mode is observed, not stored) ─────────────────

type OutcomeCounters = Record<SlackInboundOutcomeState, number> & {
  lastOutcomeAt: string | null;
  lastFailure: { code: string; at: string } | null;
};

function emptyCounters(): OutcomeCounters {
  return {
    processed: 0,
    ignored: 0,
    failed: 0,
    uncertain: 0,
    lastOutcomeAt: null,
    lastFailure: null,
  };
}

const counters: Record<SlackInboundTransport, OutcomeCounters> = {
  socket: emptyCounters(),
  http: emptyCounters(),
};

function recordOutcome(transport: SlackInboundTransport, outcome: SlackInboundOutcome): void {
  const bucket = counters[transport];
  const at = new Date().toISOString();
  bucket[outcome.state] += 1;
  bucket.lastOutcomeAt = at;
  if (outcome.state === "failed" || outcome.state === "uncertain") {
    bucket.lastFailure = { code: outcome.code, at };
    console.warn(`[Slack] inbound ${transport} delivery ${outcome.state}: ${outcome.code}`);
  }
}

/** Test-only. */
export function resetSlackInboundCountersForTests(): void {
  counters.socket = emptyCounters();
  counters.http = emptyCounters();
}

/**
 * First Bolt global middleware. Everything downstream (the Assistant
 * middleware and every listener) runs inside `next()`, so listener errors,
 * which Bolt routes to its error handler after this middleware, are observed
 * here and rethrown unchanged.
 */
export function slackInboundOutcomeMiddleware(): Middleware<AnyMiddlewareArgs> {
  return async ({ next }) => {
    const existing = deliveryStorage.getStore();
    if (existing) {
      // A durable delivery: the drain resolves and stores the outcome. Record
      // the error here too, because Bolt's error handler may swallow it before
      // App.processEvent() returns to the drain.
      existing.dispatched = true;
      try {
        await next();
      } catch (error) {
        existing.failures.push(errorCode(error));
        throw error;
      }
      return;
    }

    const state = newDeliveryState("socket", false);
    state.dispatched = true;
    await deliveryStorage.run(state, async () => {
      try {
        await next();
      } catch (error) {
        recordOutcome("socket", resolveSlackInboundOutcome(state, error));
        throw error;
      }
      recordOutcome("socket", resolveSlackInboundOutcome(state));
    });
  };
}

/**
 * Run `fn` as an admitted durable delivery and resolve its outcome. Never
 * throws: a thrown error becomes a `failed` or `uncertain` outcome.
 *
 * `requireBoltDispatch` turns "the Bolt middleware never ran" (authorization
 * failure, unrecognized payload) into `failed`, because `App.processEvent()`
 * resolving is not by itself evidence that a listener handled the delivery.
 */
export async function runAdmittedSlackDelivery(
  transport: SlackInboundTransport,
  fn: () => Promise<void>,
  options: { requireBoltDispatch?: boolean } = {},
): Promise<SlackInboundOutcome> {
  const state = newDeliveryState(transport, true);
  try {
    await deliveryStorage.run(state, fn);
  } catch (error) {
    return resolveSlackInboundOutcome(state, error);
  }
  if (options.requireBoltDispatch && !state.dispatched) {
    return { state: "failed", code: "not_dispatched" };
  }
  return resolveSlackInboundOutcome(state);
}

// ─── Admission ───────────────────────────────────────────────────────────────

export type SlackInboundKeyResult =
  | {
      ok: true;
      dedupKey: string;
      payloadType: string;
      apiAppId: string | null;
      eventId: string | null;
    }
  | { ok: false; reason: "missing_event_id" | "malformed" };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Derive the dedup key for a delivery.
 *
 * - Events: `(api_app_id, event_id)`. `event_callback` without an `event_id`
 *   is refused. Other event envelopes (control messages) key on a body hash.
 * - Interactions and commands carry no universal id: key on a kind-scoped
 *   SHA-256 of the original body. Action timestamps, view hashes and trigger
 *   ids make genuine later actions distinct; retry headers are not part of the
 *   body, so a retry maps to the same key.
 */
export function computeSlackInboundKey(
  kind: SlackInboundKind,
  rawBody: string,
  body: unknown,
): SlackInboundKeyResult {
  if (!body || typeof body !== "object") return { ok: false, reason: "malformed" };
  const record = body as Record<string, unknown>;
  const payloadType = stringField(record, "type") ?? (kind === "command" ? "command" : null);
  if (!payloadType) return { ok: false, reason: "malformed" };
  const apiAppId = stringField(record, "api_app_id");

  if (kind === "event" && payloadType === "event_callback") {
    const eventId = stringField(record, "event_id");
    if (!eventId) return { ok: false, reason: "missing_event_id" };
    return {
      ok: true,
      dedupKey: `event:${apiAppId ?? "-"}:${eventId}`,
      payloadType,
      apiAppId,
      eventId,
    };
  }

  return {
    ok: true,
    dedupKey: `${kind}:${payloadType}:${sha256(rawBody)}`,
    payloadType,
    apiAppId,
    eventId: null,
  };
}

export interface AdmitSlackInboundInput {
  transport: SlackInboundTransport;
  kind: SlackInboundKind;
  rawBody: string;
  body: unknown;
  retryNum?: number | null;
  retryReason?: string | null;
}

export type SlackInboundAdmitResult =
  | SlackInboundAdmission
  | { status: "invalid"; reason: "missing_event_id" | "malformed" };

/**
 * Persist a delivery before it is acknowledged. The encrypted payload and the
 * dedup key commit in one transaction; a crash after this returns leaves a
 * recoverable `pending` receipt.
 */
export async function admitSlackInbound(
  input: AdmitSlackInboundInput,
  now: Date = new Date(),
): Promise<SlackInboundAdmitResult> {
  const key = computeSlackInboundKey(input.kind, input.rawBody, input.body);
  if (!key.ok) return { status: "invalid", reason: key.reason };
  const payloadBytes = Buffer.byteLength(input.rawBody, "utf8");
  if (payloadBytes > SLACK_INBOUND_LIMITS.maxPayloadBytes) {
    return { status: "rejected", reason: "payload_too_large" };
  }
  return admitSlackInboundReceipt(
    {
      dedupKey: key.dedupKey,
      transport: input.transport,
      kind: input.kind,
      payloadType: key.payloadType,
      apiAppId: key.apiAppId,
      eventId: key.eventId,
      payloadCiphertext: encryptSecret(input.rawBody, getEncryptionKey()),
      payloadBytes,
      retryNum: input.retryNum ?? null,
      retryReason: input.retryReason ?? null,
    },
    now,
  );
}

// ─── Drain ───────────────────────────────────────────────────────────────────

export interface SlackInboundDelivery {
  receipt: SlackInboundReceipt;
  rawBody: string;
}

/** Hands one admitted delivery to Bolt (or a test double). */
export type SlackInboundProcessor = (delivery: SlackInboundDelivery) => Promise<void>;

export interface SlackInboundDrainResult {
  receiptId: string;
  outcome: SlackInboundOutcome;
  /** Where the receipt ended up after this attempt. */
  state: "pending" | SlackInboundOutcomeState;
}

/**
 * Claim and process the oldest available receipt. Returns null when nothing
 * is claimable.
 */
export async function processNextSlackInboundReceipt(
  processor: SlackInboundProcessor,
  options: { now?: () => Date; requireBoltDispatch?: boolean } = {},
): Promise<SlackInboundDrainResult | null> {
  const now = options.now ?? (() => new Date());
  const receipt = await claimSlackInboundReceipt(now());
  if (!receipt) return null;

  let rawBody: string;
  try {
    if (!receipt.payloadCiphertext) throw new Error("payload already erased");
    rawBody = decryptSecret(receipt.payloadCiphertext, getEncryptionKey());
  } catch {
    // Nothing ran, but retrying cannot fix an unreadable payload.
    const outcome: SlackInboundOutcome = { state: "failed", code: "payload_unreadable" };
    await completeSlackInboundReceipt(
      receipt.id,
      { state: "failed", errorCode: outcome.code },
      now(),
    );
    recordOutcome(receipt.transport, outcome);
    return { receiptId: receipt.id, outcome, state: "failed" };
  }

  const outcome = await runAdmittedSlackDelivery(
    receipt.transport,
    () => processor({ receipt, rawBody }),
    { requireBoltDispatch: options.requireBoltDispatch },
  );
  recordOutcome(receipt.transport, outcome);

  if (outcome.state === "failed" && receipt.attempts < SLACK_INBOUND_LIMITS.maxAttempts) {
    const availableAt = new Date(
      now().getTime() + SLACK_INBOUND_LIMITS.retryBackoffMs * receipt.attempts,
    );
    await releaseSlackInboundReceipt(receipt.id, outcome.code, availableAt, now());
    return { receiptId: receipt.id, outcome, state: "pending" };
  }

  await completeSlackInboundReceipt(
    receipt.id,
    {
      state: outcome.state,
      outcomeCode:
        outcome.state === "processed" || outcome.state === "ignored" ? outcome.code : null,
      errorCode: outcome.state === "failed" || outcome.state === "uncertain" ? outcome.code : null,
    },
    now(),
  );
  return { receiptId: receipt.id, outcome, state: outcome.state };
}

/**
 * One bounded, single-flight drain. `wake()` starts a pass (or schedules one
 * more pass if a drain is already running) and resolves when the drain goes
 * idle. At most `maxPerPass` receipts are processed per pass.
 */
export function createSlackInboundDrain(
  processor: SlackInboundProcessor,
  options: { maxPerPass?: number; requireBoltDispatch?: boolean } = {},
): { wake(): Promise<void> } {
  const maxPerPass = options.maxPerPass ?? 50;
  let running: Promise<void> | null = null;
  let again = false;

  const pass = async () => {
    for (let i = 0; i < maxPerPass; i++) {
      const result = await processNextSlackInboundReceipt(processor, {
        requireBoltDispatch: options.requireBoltDispatch,
      });
      if (!result) return;
    }
  };

  const loop = async () => {
    do {
      again = false;
      try {
        await pass();
      } catch (error) {
        // A DB failure mid-pass leaves the receipt `processing`; boot recovery
        // turns it `uncertain`. Never loop hot on a broken store.
        console.error("[Slack] inbound drain pass failed:", scrubSecrets(String(error)));
        return;
      }
    } while (again);
  };

  return {
    wake() {
      if (running) {
        again = true;
        return running;
      }
      running = loop().finally(() => {
        running = null;
      });
      return running;
    },
  };
}

/** Boot recovery; call once before the drain starts. */
export async function recoverSlackInboundAfterRestart(now: Date = new Date()): Promise<number> {
  const interrupted = await markInterruptedSlackInboundReceiptsUncertain(now);
  if (interrupted > 0) {
    console.warn(
      `[Slack] ${interrupted} inbound receipt(s) were interrupted mid-processing and are now uncertain`,
    );
  }
  return interrupted;
}

// ─── Diagnostics ─────────────────────────────────────────────────────────────

export interface SlackInboundDiagnostics {
  mode: SlackMode | null;
  disabled: boolean;
  receipts: SlackInboundReceiptStats;
  outcomes: Record<SlackInboundTransport, OutcomeCounters>;
  limits: typeof SLACK_INBOUND_LIMITS;
}

/** Operator view. Contains no payloads, tokens, signatures or response URLs. */
export async function getSlackInboundDiagnostics(): Promise<SlackInboundDiagnostics> {
  const config = getSlackConfiguration();
  return {
    mode: config.mode,
    disabled: config.disabled,
    receipts: await getSlackInboundReceiptStats(),
    outcomes: {
      socket: { ...counters.socket },
      http: { ...counters.http },
    },
    limits: SLACK_INBOUND_LIMITS,
  };
}
