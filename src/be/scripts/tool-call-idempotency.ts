import { MAX_KV_BODY_BYTES } from "../../kv-limits";
import { claimKv, getKv } from "../db";
import { deleteKvIfValue, replaceKvIfValue } from "../db/kv";
import { sha256 } from "../db/workflow-idempotency";

/**
 * Per-call idempotency for side-effecting tools called through the scripts
 * MCP bridge (`POST /api/mcp-bridge` with an `Idempotency-Key`). The first call
 * under a (caller, tool, key) runs the tool and records its result; a later
 * call under the same scope gets that result back and runs nothing. Durable
 * script runs key every `ctx.swarm.*` call, so a respawned run that re-executes
 * its body does not send, post or write twice.
 *
 * Records live in the private, reserved KV family below. A failed call (thrown
 * or a tool refusal) records nothing, so a retry runs it again.
 */
export const TOOL_CALL_IDEMPOTENCY_NAMESPACE = "tool-call-idempotency";

/**
 * How long a completed call is remembered. Long enough for a paused durable
 * run to resume days later and still replay; the default run wall clock is 24h.
 */
export const TOOL_CALL_IDEMPOTENCY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long an in-flight claim holds the key without a renewal. The owner renews
 * it every quarter lease while the call runs, so a slow call keeps its key; a
 * claim whose server died is taken over after this, so the call can run twice
 * only when the server died (or stalled a whole lease) mid-call.
 */
export const TOOL_CALL_IDEMPOTENCY_LEASE_MS = 2 * 60 * 1000;
const LEASE_RENEW_MS = TOOL_CALL_IDEMPOTENCY_LEASE_MS / 4;

/** How long a duplicate waits for the first call before it gets a 409. */
const IN_FLIGHT_WAIT_MS = 30_000;

type Record_ =
  | { state: "pending"; token: string }
  | { state: "done"; result: unknown }
  | { state: "done"; resultOmitted: true };

export interface ToolCallIdempotencyScope {
  /** Stable caller identity, e.g. `agent:<id>`; never a credential value. */
  principal: string;
  /** The MCP tool name. */
  tool: string;
  /** The client's key. Stored only as part of a hash. */
  key: string;
}

/** A second call under a key whose first call is still running. */
export class ToolCallInFlightError extends Error {
  constructor(tool: string) {
    super(
      `A call to '${tool}' with this Idempotency-Key is still running; retry after it finishes`,
    );
    this.name = "ToolCallInFlightError";
  }
}

/** The stored result when the original was too large to keep. */
export const RESULT_OMITTED = {
  success: true,
  idempotentReplay: true,
  message:
    "This call already ran under the same Idempotency-Key. Its result was too large to keep, so it is not repeated here.",
} as const;

function recordKey(scope: ToolCallIdempotencyScope): string {
  return sha256(`${scope.principal}\0${scope.tool}\0${scope.key}`);
}

/**
 * Run `invoke` at most once per scope while its record lives. `shouldRecord`
 * says whether a result counts as done (a tool refusal does not).
 */
export async function runIdempotentToolCall<T>(
  scope: ToolCallIdempotencyScope,
  invoke: () => Promise<T>,
  shouldRecord: (result: T) => boolean,
): Promise<{ result: T | typeof RESULT_OMITTED; replayed: boolean }> {
  const namespace = TOOL_CALL_IDEMPOTENCY_NAMESPACE;
  const key = recordKey(scope);
  const token = crypto.randomUUID();
  const deadline = Date.now() + IN_FLIGHT_WAIT_MS;
  const pending: Record_ = { state: "pending", token };
  for (;;) {
    if (
      await claimKv({
        namespace,
        key,
        value: pending,
        valueType: "json",
        expiresAt: Date.now() + TOOL_CALL_IDEMPOTENCY_LEASE_MS,
      })
    ) {
      break;
    }
    const existing = (await getKv(namespace, key))?.value as Record_ | undefined;
    if (existing?.state === "done") {
      return {
        result: "resultOmitted" in existing ? RESULT_OMITTED : (existing.result as T),
        replayed: true,
      };
    }
    // Missing means the claim expired between the two reads: claim again.
    if (existing && Date.now() >= deadline) throw new ToolCallInFlightError(scope.tool);
    if (existing) await Bun.sleep(100 + Math.floor(Math.random() * 200));
  }

  // Every write below is a compare-and-set on our own pending value, so an
  // owner whose claim was taken over never renews, records or releases it.
  let renewing: Promise<unknown> = Promise.resolve();
  const renewTimer = setInterval(() => {
    renewing = renewing.then(() =>
      replaceKvIfValue({
        namespace,
        key,
        expected: pending,
        value: pending,
        valueType: "json",
        expiresAt: Date.now() + TOOL_CALL_IDEMPOTENCY_LEASE_MS,
      }).catch(() => {
        // A failed renewal retries on the next tick; the lease covers four.
      }),
    );
  }, LEASE_RENEW_MS);
  const stopRenewing = async () => {
    clearInterval(renewTimer);
    await renewing;
  };
  const release = async () => {
    await stopRenewing();
    await deleteKvIfValue(namespace, key, pending, "json");
  };

  let result: T;
  try {
    result = await invoke();
  } catch (error) {
    await release();
    throw error;
  }
  if (!shouldRecord(result)) {
    await release();
    return { result, replayed: false };
  }
  await stopRenewing();
  const encoded = JSON.stringify(result);
  const done: Record_ =
    encoded !== undefined && Buffer.byteLength(encoded, "utf8") <= MAX_KV_BODY_BYTES
      ? { state: "done", result }
      : { state: "done", resultOmitted: true };
  const record = {
    namespace,
    key,
    value: done,
    valueType: "json" as const,
    expiresAt: Date.now() + TOOL_CALL_IDEMPOTENCY_TTL_MS,
  };
  // Our claim, or none left (it lapsed and a duplicate's read swept it): record.
  // A takeover's live claim or record keeps the key.
  if (!(await replaceKvIfValue({ ...record, expected: pending }))) await claimKv(record);
  return { result, replayed: false };
}
