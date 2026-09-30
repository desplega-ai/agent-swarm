import { webApi } from "@slack/bolt";
import type { WebClient } from "@slack/web-api";
import {
  getSlackTasksInThread,
  isSlackThreadAwaitingHuman,
  listSlackThreadsAwaitingHuman,
} from "../be/db";
import { type AgentTask, isTerminalTaskStatus } from "../types";
import { scrubSecrets } from "../utils/secret-scrubber";
import { getSlackApp } from "./app";

/**
 * Slack's native "working" state for a thread (`agents.sessions.setStatus`,
 * bot scope `chat:write`, no manifest change). Slack shows its loading UI
 * while the session is `processing`, marks it `suspended` when the agent is
 * blocked on a person, and clears the indicator on `active`.
 *
 * Three properties of the method shape this file:
 *  - It does not clear itself when the app posts a message (the legacy
 *    `assistant.threads.setStatus` did), and Slack drops a `processing`
 *    session after one hour. So the state is reconciled against the thread's
 *    tasks every render tick, and `processing` is re-asserted before the hour
 *    is up, so an ask that runs for many hours keeps its indicator.
 *  - It works in channel threads as well as DMs, and creates the session on
 *    first use.
 *  - Slack shows a Stop button only if the app subscribes to
 *    `agent_session_stopped`. The manifest does not, so there is none.
 *
 * The indicator is only ever a nicety. Every failure is absorbed here: the
 * thread keeps the reaction and the tree message (DMs also keep the legacy
 * indicator), and nothing in this file throws into a task.
 *
 * A write that got no answer (timeout, reset) may still have reached Slack, so
 * the thread is marked `uncertain` and the next reconcile writes whatever it
 * wants even when the books say "already clear". Writes go through an isolated
 * client (see `statusTransport`) so such a write is aborted at the timeout
 * instead of landing minutes later.
 */

export type SlackSessionStatus = "processing" | "suspended" | "active";

/** Slack ends a `processing` session after one hour; re-assert well inside it. */
const REFRESH_MS = 30 * 60_000;
const DEFAULT_CALL_TIMEOUT_MS = 8_000;
/** The status client aborts its HTTP request this long before the local timeout backstops a transport that does not. */
const TRANSPORT_MARGIN_MS = 500;
let callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
const RETRY_BASE_MS = 30_000;
const RETRY_MAX_MS = 10 * 60_000;
/** After a workspace-level refusal, stay off the native call this long, then probe again. */
const UNAVAILABLE_COOLDOWN_MS = 60 * 60_000;
/** Slack allows 50+ calls a minute (Tier 3); a restart with many live threads spreads over ticks. */
const CALLS_PER_TICK = 8;
/**
 * A `processing` mark can precede its task row (a DM downloading attachments),
 * so the sweep leaves a fresh one alone instead of clearing it under the task.
 */
const ORPHAN_GRACE_MS = 2 * 60_000;

/**
 * Errors that say this workspace, app or token cannot use the method at all:
 * a missing scope, the feature off, a token that is not a bot token, a
 * revoked install. Retrying per thread would only repeat them.
 */
const WORKSPACE_ERRORS = new Set([
  "missing_scope",
  "not_allowed_token_type",
  "feature_disabled",
  "not_authed",
  "invalid_auth",
  "account_inactive",
  "token_revoked",
  "token_expired",
  "access_denied",
  "no_permission",
  "accesslimited",
  "enterprise_is_restricted",
  "ekm_access_denied",
  "org_login_required",
  "method_deprecated",
  "deprecated_endpoint",
  "unknown_method",
]);

/** Errors that answer differently on a later attempt. */
const TRANSIENT_ERRORS = new Set([
  "ratelimited",
  "rate_limited",
  "internal_error",
  "service_unavailable",
  "fatal_error",
  "request_timeout",
]);

type ThreadEntry = {
  /** The last status Slack accepted for the thread. */
  status: SlackSessionStatus;
  setAt: number;
  failures: number;
  retryAt: number;
  /** Slack refused this thread (e.g. the bot is not in the channel); leave it alone until it goes idle. */
  refused: boolean;
  /**
   * The last write got no answer, so Slack may hold a status that `status`
   * does not show. Reconciling writes the desired status even if it equals
   * `status`, and a clear is never skipped as "already clear".
   */
  uncertain: boolean;
  /**
   * A reconcile that knew the thread's tasks wanted a different status but the
   * tick's budget was spent. Due on the next sweep, grace period or not.
   */
  deferred?: boolean;
};

const threads = new Map<string, ThreadEntry>();
const keyTails = new Map<string, Promise<unknown>>();
const warned = new Set<string>();
let unavailableUntil = 0;

type ApplyResult = "applied" | "current" | "idle" | "unavailable";

export type StatusBudget = { remaining: number };

function threadKey(channelId: string, threadTs: string): string {
  return `${channelId}:${threadTs}`;
}

function splitKey(key: string): { channelId: string; threadTs: string } {
  const at = key.indexOf(":");
  return { channelId: key.slice(0, at), threadTs: key.slice(at + 1) };
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { data?: { error?: string } })?.data?.error;
  return typeof code === "string" && code.length > 0 ? code : undefined;
}

function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(scrubSecrets(`[Slack] ${message}`));
}

class CallTimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = "CallTimeoutError";
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new CallTimeoutError(ms)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

type StatusTransport = Pick<WebClient, "apiCall">;
let transports = new WeakMap<WebClient, StatusTransport>();

/**
 * The client native status writes go through. The shared Bolt client retries
 * a failed call for up to 30 minutes and, on a 429, pauses its queue for every
 * method, so a slow status write could land long after the ask ended and stall
 * tree delivery. This is a sibling client with its own queue, no automatic
 * retries, rate limits surfaced as errors, and an HTTP timeout that aborts the
 * request. Anything that is not a real `WebClient` (a test double, or a
 * transport that is already isolated) is used as it is.
 */
function statusTransport(client: WebClient): StatusTransport {
  if (!(client instanceof webApi.WebClient)) return client;
  let transport = transports.get(client);
  if (!transport) {
    const timeout = Math.max(callTimeoutMs - TRANSPORT_MARGIN_MS, 1);
    transport = new webApi.WebClient(client.token ?? process.env.SLACK_BOT_TOKEN, {
      slackApiUrl: client.slackApiUrl,
      retryConfig: { retries: 0 },
      rejectRateLimitedCalls: true,
      timeout,
      // Axios' own timeout leaves the socket open under Bun; an abort signal closes it.
      requestInterceptor: (config) => ({ ...config, signal: AbortSignal.timeout(timeout) }),
    });
    transports.set(client, transport);
  }
  return transport;
}

/** Runs `fn` after every earlier call for the same thread has finished. */
function withThreadLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const run = (keyTails.get(key) ?? Promise.resolve()).then(fn);
  const tail = run.catch(() => undefined);
  keyTails.set(key, tail);
  void tail.then(() => {
    if (keyTails.get(key) === tail) keyTails.delete(key);
  });
  return run;
}

/**
 * The status a thread should show, from its tasks. Running work wins over a
 * pending human request: the swarm is only "waiting on you" once nothing is
 * left to run. A deferred ask (its task is `completed`, a schedule wakes it)
 * reads `active` until the wake-up task appears.
 */
function decideSlackSessionStatus(
  tasks: readonly Pick<AgentTask, "status">[],
  awaitingHuman: boolean,
): SlackSessionStatus {
  if (tasks.some((task) => !isTerminalTaskStatus(task.status))) return "processing";
  return awaitingHuman ? "suspended" : "active";
}

async function desiredStatus(channelId: string, threadTs: string): Promise<SlackSessionStatus> {
  const tasks = await getSlackTasksInThread(channelId, threadTs);
  const running = tasks.some((task) => !isTerminalTaskStatus(task.status));
  const awaitingHuman = running ? false : await isSlackThreadAwaitingHuman(channelId, threadTs);
  return decideSlackSessionStatus(tasks, awaitingHuman);
}

type CallFailure = "unavailable" | "refused" | "transient";

function classify(error: unknown): { kind: CallFailure; code: string } {
  const code = errorCode(error);
  // No Slack verdict: a timeout, a socket reset, or a rate limit the client surfaced.
  if (!code) return { kind: "transient", code: "no_slack_verdict" };
  if (WORKSPACE_ERRORS.has(code)) return { kind: "unavailable", code };
  if (TRANSIENT_ERRORS.has(code)) return { kind: "transient", code };
  return { kind: "refused", code };
}

function retryAfterMs(error: unknown): number | undefined {
  const seconds = (error as { retryAfter?: number })?.retryAfter;
  return typeof seconds === "number" && seconds > 0 ? seconds * 1_000 : undefined;
}

/**
 * Writes `desired` for one thread when it differs from what Slack last
 * accepted (or when `processing` is about to lapse). Callers hold the thread
 * lock.
 */
async function applyStatus(
  client: WebClient,
  channelId: string,
  threadTs: string,
  desired: SlackSessionStatus,
  budget?: StatusBudget,
): Promise<ApplyResult> {
  const key = threadKey(channelId, threadTs);
  const now = Date.now();
  const entry = threads.get(key);

  // Slack refuses this workspace, or this thread: nothing to write, and
  // nothing worth remembering about a status we can no longer clear.
  if (now < unavailableUntil || entry?.refused) {
    if (desired === "active") threads.delete(key);
    return "unavailable";
  }
  if (desired === "active") {
    // Nothing was ever set for this thread, or it is known to be clear. An
    // entry whose last write went unanswered is not known to be either.
    if (!entry || (entry.status === "active" && !entry.uncertain)) {
      threads.delete(key);
      return "idle";
    }
  } else if (
    entry &&
    entry.status === desired &&
    !entry.uncertain &&
    now - entry.setAt < REFRESH_MS
  ) {
    return "current";
  }
  if (entry && now < entry.retryAt) return "unavailable";
  if (budget) {
    if (budget.remaining <= 0) {
      if (entry) threads.set(key, { ...entry, deferred: true });
      return "unavailable";
    }
    budget.remaining--;
  }

  const pending = statusTransport(client).apiCall("agents.sessions.setStatus", {
    channel_id: channelId,
    thread_ts: threadTs,
    status: desired,
  });
  try {
    const result = (await withTimeout(pending, callTimeoutMs)) as { ok?: boolean; error?: string };
    if (result?.ok === false) throw { data: { error: result.error ?? "unknown_error" } };
  } catch (error) {
    // The request is still out there. If it lands after we gave up, record
    // what Slack now holds and reconcile against the thread's tasks again.
    if (error instanceof CallTimeoutError) {
      pending.then(
        (late) => {
          if ((late as { ok?: boolean })?.ok !== false) {
            void noteLateWrite(client, channelId, threadTs, desired);
          }
        },
        () => {},
      );
    }
    const failure = classify(error);
    if (failure.kind === "unavailable") {
      unavailableUntil = now + UNAVAILABLE_COOLDOWN_MS;
      warnOnce(
        `unavailable:${failure.code}`,
        `Native session status is unavailable (${failure.code}). Keeping the reaction and tree message${
          failure.code === "missing_scope" ? "; the bot token needs the chat:write scope" : ""
        }. Will probe again in ${UNAVAILABLE_COOLDOWN_MS / 60_000} min.`,
      );
    } else if (failure.kind === "refused") {
      threads.set(key, {
        status: entry?.status ?? "active",
        setAt: entry?.setAt ?? 0,
        failures: 0,
        retryAt: 0,
        refused: true,
        uncertain: false,
      });
      warnOnce(
        `refused:${failure.code}`,
        `Slack refused a session status for ${channelId}/${threadTs} (${failure.code}). Leaving that thread on the reaction and tree message.`,
      );
    } else {
      const failures = (entry?.failures ?? 0) + 1;
      const backoff = Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      threads.set(key, {
        status: entry?.status ?? "active",
        setAt: entry?.setAt ?? 0,
        failures,
        retryAt: now + Math.max(backoff, retryAfterMs(error) ?? 0),
        refused: false,
        // No verdict: the write may have reached Slack before the answer was lost.
        uncertain: true,
      });
      warnOnce(
        `transient:${failure.code}`,
        `Setting the session status failed (${failure.code}); retrying with backoff.`,
      );
    }
    return "unavailable";
  }

  if (desired === "active") threads.delete(key);
  else {
    threads.set(key, {
      status: desired,
      setAt: now,
      failures: 0,
      retryAt: 0,
      refused: false,
      uncertain: false,
    });
  }
  return "applied";
}

/**
 * A write we timed out on has now been answered, so Slack holds `landed`,
 * which may not be what the thread's tasks call for by now (the ask finished
 * while the request was out). Record that and reconcile again. The isolated
 * transport aborts at its timeout, so this is the path for a transport that
 * cannot, and for an answer that was only slow.
 */
async function noteLateWrite(
  client: WebClient,
  channelId: string,
  threadTs: string,
  landed: SlackSessionStatus,
): Promise<void> {
  try {
    const key = threadKey(channelId, threadTs);
    await withThreadLock(key, async () => {
      if (landed === "active") threads.delete(key);
      else {
        threads.set(key, {
          status: landed,
          setAt: Date.now(),
          failures: 0,
          retryAt: 0,
          refused: false,
          uncertain: false,
        });
      }
    });
    await reconcileSlackSessionStatus({ channelId, threadTs, client });
  } catch (error) {
    warnOnce(
      "late-write",
      `Reconciling a late session status write failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** The pre-native DM indicator, kept as the fallback for an outcome that just landed. */
async function clearLegacyDmStatus(
  client: WebClient,
  channelId: string,
  threadTs: string,
): Promise<void> {
  if (!channelId.startsWith("D")) return;
  try {
    await client.apiCall("assistant.threads.setStatus", {
      channel_id: channelId,
      thread_ts: threadTs,
      status: "",
    });
  } catch (error) {
    warnOnce(
      "legacy-clear",
      `Failed to clear the assistant status for ${channelId}/${threadTs}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Brings a thread's native status in line with its tasks: `processing` while
 * any task runs, `suspended` while only a human request is open, `active`
 * (cleared) otherwise. Idempotent and cheap: it calls Slack only when the
 * status changes or a `processing` state needs re-asserting. Never throws.
 *
 * `outcomeDelivered` is set right after an outcome card landed. If the native
 * call cannot be used, a DM then falls back to clearing the legacy indicator,
 * exactly as before native status existed.
 */
export async function reconcileSlackSessionStatus(input: {
  channelId: string;
  threadTs: string;
  client?: WebClient;
  budget?: StatusBudget;
  outcomeDelivered?: boolean;
}): Promise<void> {
  try {
    const client = input.client ?? getSlackApp()?.client;
    if (!client) return;
    const { channelId, threadTs } = input;
    await withThreadLock(threadKey(channelId, threadTs), async () => {
      const desired = await desiredStatus(channelId, threadTs);
      const result = await applyStatus(client, channelId, threadTs, desired, input.budget);
      if (input.outcomeDelivered && result === "unavailable") {
        await clearLegacyDmStatus(client, channelId, threadTs);
      }
    });
  } catch (error) {
    warnOnce(
      "reconcile",
      `Session status sync failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Marks a thread `processing` right away, before any task row exists (a DM
 * downloading attachments, for instance). Returns false when native status
 * cannot be used for the thread, so the caller can fall back to its own
 * indicator. Never throws.
 */
export async function markSlackSessionProcessing(input: {
  channelId: string;
  threadTs: string;
  client?: WebClient;
}): Promise<boolean> {
  try {
    const client = input.client ?? getSlackApp()?.client;
    if (!client) return false;
    const { channelId, threadTs } = input;
    return await withThreadLock(threadKey(channelId, threadTs), async () => {
      const result = await applyStatus(client, channelId, threadTs, "processing");
      return result === "applied" || result === "current";
    });
  } catch {
    return false;
  }
}

/**
 * One render tick's worth of status work. `reconcile` runs for each thread
 * tree the tick visits; `finish` then covers the threads the tick did not
 * reach: ones that only wait on a human (their tasks are all finished, so no
 * tree is being rendered) and ones this process set a status on that must now
 * be cleared or retried.
 */
export function beginSlackStatusTick(): {
  /** Shared by every native status write the tick starts; hand it to anything the tick calls that may write. */
  budget: StatusBudget;
  reconcile: (channelId: string, threadTs: string) => Promise<void>;
  finish: () => Promise<void>;
} {
  const budget: StatusBudget = { remaining: CALLS_PER_TICK };
  const visited = new Set<string>();
  return {
    budget,
    reconcile: async (channelId, threadTs) => {
      visited.add(threadKey(channelId, threadTs));
      await reconcileSlackSessionStatus({ channelId, threadTs, budget });
    },
    finish: async () => {
      try {
        const targets = new Map<string, { channelId: string; threadTs: string }>();
        const now = Date.now();
        for (const [key, entry] of threads) {
          const inGrace =
            entry.status === "processing" &&
            !entry.uncertain &&
            !entry.deferred &&
            now - entry.setAt < ORPHAN_GRACE_MS;
          if (inGrace) continue;
          targets.set(key, splitKey(key));
        }
        for (const thread of await listSlackThreadsAwaitingHuman()) {
          targets.set(threadKey(thread.channelId, thread.threadTs), thread);
        }
        for (const [key, thread] of targets) {
          if (visited.has(key)) continue;
          await reconcileSlackSessionStatus({ ...thread, budget });
        }
      } catch (error) {
        warnOnce(
          "tick-finish",
          `Session status sweep failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function _setSlackSessionStatusTimeoutForTests(ms: number | undefined): void {
  callTimeoutMs = ms ?? DEFAULT_CALL_TIMEOUT_MS;
}

export function _resetSlackSessionStatusForTests(): void {
  callTimeoutMs = DEFAULT_CALL_TIMEOUT_MS;
  transports = new WeakMap();
  threads.clear();
  keyTails.clear();
  warned.clear();
  unavailableUntil = 0;
}
