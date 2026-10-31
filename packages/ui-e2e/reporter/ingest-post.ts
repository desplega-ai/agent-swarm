import type { IngestPayload } from "./ingest-payload.ts";

// Waits between attempts: 15s, 30s, 60s, 120s, 120s. Six attempts span about
// 6 minutes of waiting, longer than an API deploy restart (about 5 minutes).
export const RETRY_DELAYS_MS = [15_000, 30_000, 60_000, 120_000, 120_000];

// The ingest endpoint answers HTTP 200 with `ok: false` when the script itself
// failed. These messages mean the script lost its connection to the API, not
// that the payload was rejected.
const TRANSPORT_ERROR =
  /ECONNRESET|ECONNREFUSED|ECONNABORTED|EPIPE|ETIMEDOUT|EAI_AGAIN|socket connection was closed|fetch failed|Unable to connect|Bad Gateway|Service Unavailable|Gateway Timeout/i;

export interface PostOptions {
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  delaysMs?: number[];
}

interface Attempt {
  status: number;
  body: unknown;
  durationMs: number;
  ok: boolean;
  retryable: boolean;
}

function redact(value: string, bearer: string): string {
  return value.replaceAll(bearer, "[redacted]");
}

function compact(value: unknown, bearer: string): string {
  return redact(JSON.stringify(value), bearer).slice(0, 500);
}

function responseDetails(body: unknown, bearer: string): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const record = body as Record<string, unknown>;
  // A failed run carries `result: null`; print its error message instead.
  if (record.result != null) return compact(record.result, bearer);
  const error = record.error;
  if (typeof error === "object" && error !== null) {
    const message = (error as Record<string, unknown>).message;
    if (typeof message === "string") return redact(message, bearer).slice(0, 500);
  }
  return undefined;
}

export function isTransportFailure(body: unknown): boolean {
  if (typeof body !== "object" || body === null) return false;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return false;
  const { type, message } = error as Record<string, unknown>;
  // The sandbox was full, so the script never ran.
  if (type === "capacity_exceeded") return true;
  return type === "runtime_error" && typeof message === "string" && TRANSPORT_ERROR.test(message);
}

// A resend is idempotent only for a shard without failed specs: runs, results,
// artifacts and run groups are upserts keyed by runKey, but every ingest of a
// failed spec adds one to its incident's `occurrences`.
function safeToResend(payload: IngestPayload): boolean {
  return payload.results.every((result) => result.status !== "failed");
}

async function attempt(
  payload: IngestPayload,
  url: string,
  bearer: string,
  fetchImpl: typeof fetch,
): Promise<Attempt> {
  let status = 0;
  let body: unknown;
  let durationMs = 0;
  try {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
        "X-Swarm-Timeout-Ms": "180000",
      },
      body: JSON.stringify(payload),
    });
    status = response.status;
    const text = await response.text();
    try {
      body = JSON.parse(text);
    } catch {
      body = { error: { message: `Non-JSON response: ${text.slice(0, 200)}` } };
    }
    if (typeof body === "object" && body !== null) {
      const responseBody = body as Record<string, unknown>;
      if (typeof responseBody.durationMs === "number") durationMs = responseBody.durationMs;
    }
  } catch (error) {
    body = { error: { message: error instanceof Error ? error.message : String(error) } };
  }

  const ok =
    status === 200 &&
    typeof body === "object" &&
    body !== null &&
    (body as Record<string, unknown>).ok === true;
  const retryable =
    !ok && (status === 0 || status >= 500 || (status === 200 && isTransportFailure(body)));
  return { status, body, durationMs, ok, retryable };
}

export async function postPayloads(
  payloads: IngestPayload[],
  url: string,
  bearer: string,
  options: PostOptions = {},
): Promise<boolean> {
  const fetchImpl = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const delaysMs = options.delaysMs ?? RETRY_DELAYS_MS;
  const maxAttempts = delaysMs.length + 1;
  const host = new URL(url).host;
  console.log(`ingest host: ${host}`);
  let succeeded = true;

  for (const payload of payloads) {
    const shard = payload.run.shardIndex;
    for (let number = 1; ; number += 1) {
      const result = await attempt(payload, url, bearer, fetchImpl);
      console.log(
        `shard ${shard}: HTTP ${result.status} ok=${result.ok} durationMs=${result.durationMs} attempt=${number}/${maxAttempts}`,
      );
      const details = responseDetails(result.body, bearer);
      if (details) console.log(details);
      if (result.ok) break;

      if (!result.retryable) {
        succeeded = false;
        break;
      }
      if (!safeToResend(payload)) {
        console.log(
          `shard ${shard}: not retrying, the shard has failed specs and a resend would double-count incident occurrences`,
        );
        succeeded = false;
        break;
      }
      const delay = delaysMs[number - 1];
      if (delay === undefined) {
        console.log(`shard ${shard}: giving up after ${maxAttempts} attempts`);
        succeeded = false;
        break;
      }
      console.log(`shard ${shard}: transient failure, retrying in ${delay / 1000}s`);
      await sleep(delay);
    }
  }

  return succeeded;
}
