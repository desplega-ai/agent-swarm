import type { AckFn, App, Receiver } from "@slack/bolt";
import { verifySlackRequest } from "@slack/bolt";
import { scrubSecrets } from "../utils/secret-scrubber";
import {
  admitSlackInbound,
  recordSlackEventRanInline,
  recordSlackInboundWithheld,
} from "./inbound-dispatch";
import { isOrderDependentEvent } from "./socket-ack";
import { checkInboundWorkspace, getCachedSlackWorkspaceIdentity } from "./workspace-guard";

/** Slack's own replay window; applied in both directions. */
const MAX_TIMESTAMP_SKEW_SEC = 5 * 60;
/** Slack gives a command or interactive payload 3s to ack. Answer before it does. */
export const SLACK_HTTP_ACK_TIMEOUT_MS = 2_500;
const RETRY_AFTER_SEC = "5";

export interface SlackHttpInput {
  rawBody: Buffer;
  signature: string | undefined;
  timestamp: string | undefined;
  contentType: string | undefined;
  retryNum: string | undefined;
  retryReason: string | undefined;
  signingSecret: string;
}

export interface SlackHttpResult {
  status: number;
  body?: string;
  contentType?: string;
  headers?: Record<string, string>;
}

const EMPTY_OK: SlackHttpResult = { status: 200 };

function jsonResult(
  status: number,
  body: unknown,
  headers?: Record<string, string>,
): SlackHttpResult {
  return { status, body: JSON.stringify(body), contentType: "application/json", headers };
}

/** Error bodies carry a stable code only: never the payload, the secret or the verifier's message. */
function refuse(status: number, error: string, headers?: Record<string, string>): SlackHttpResult {
  return jsonResult(status, { error }, headers);
}

type ParsedBody =
  | { kind: "json"; body: Record<string, unknown> }
  | { kind: "live"; body: Record<string, unknown> }
  | { kind: "ssl_check" };

/** JSON is the Events API; a form is a slash command (`command`) or interactivity (`payload`). */
function parseSlackBody(text: string, contentType: string | undefined): ParsedBody | null {
  const type = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  try {
    if (type === "application/json") {
      const body: unknown = JSON.parse(text);
      return body && typeof body === "object" && !Array.isArray(body)
        ? { kind: "json", body: body as Record<string, unknown> }
        : null;
    }
    if (type === "application/x-www-form-urlencoded") {
      const form = new URLSearchParams(text);
      if (form.has("ssl_check")) return { kind: "ssl_check" };
      const payload = form.get("payload");
      if (payload !== null) {
        const body: unknown = JSON.parse(payload);
        return body && typeof body === "object" && !Array.isArray(body)
          ? { kind: "live", body: body as Record<string, unknown> }
          : null;
      }
      if (form.has("command")) return { kind: "live", body: Object.fromEntries(form) };
    }
  } catch {
    // Malformed after a valid signature: a 400, not an error to log.
  }
  return null;
}

function parseRetryNum(value: string | undefined): number | null {
  if (!value || !/^\d{1,3}$/.test(value)) return null;
  return Number(value);
}

/** Bolt's ack argument as an HTTP response: empty, text, or JSON. */
function ackResult(response: unknown): SlackHttpResult {
  if (response === undefined || response === null || response === "") return EMPTY_OK;
  if (typeof response === "string") {
    return { status: 200, body: response, contentType: "text/plain; charset=utf-8" };
  }
  return jsonResult(200, response);
}

/**
 * Bolt `Receiver` for `SLACK_MODE=http`. It owns no port or server: the API
 * route `POST /api/integrations/slack/events` calls `handle()`, and Bolt stays
 * the dispatcher through `app.processEvent`, as in Socket Mode.
 *
 * Gate order, each before any work: valid headers and a fresh timestamp, HMAC v0
 * over the raw bytes, a parseable body, then (for everything but
 * `url_verification`) a resolved and matching workspace identity.
 *
 * Events are stored as durable receipts before the 200, so the ack is a DB
 * insert and a Slack retry (same `event_id`) never creates a second task, also
 * across a restart. Commands and interactivity run live and ack from their
 * handler, as in Socket Mode: Slack never retries them.
 */
export class SwarmHttpReceiver implements Receiver {
  private app: App | null = null;
  private ready = false;

  /** `onAdmitted` starts the durable drain after an event was stored. */
  constructor(private readonly onAdmitted: () => void) {}

  init(app: App): void {
    this.app = app;
  }

  /** Open for deliveries: this swarm's identity is known and Bolt is initialized. */
  markReady(): void {
    this.ready = true;
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {}

  async handle(input: SlackHttpInput, now: number = Date.now()): Promise<SlackHttpResult> {
    if (!input.signature || !input.timestamp || !/^\d{1,12}$/.test(input.timestamp)) {
      return refuse(401, "invalid_signature");
    }
    const timestampSec = Number(input.timestamp);
    if (Math.abs(now / 1000 - timestampSec) > MAX_TIMESTAMP_SKEW_SEC) {
      return refuse(401, "invalid_signature");
    }
    const text = input.rawBody.toString("utf8");
    try {
      verifySlackRequest({
        signingSecret: input.signingSecret,
        body: text,
        headers: {
          "x-slack-signature": input.signature,
          "x-slack-request-timestamp": timestampSec,
        },
        nowMilliseconds: now,
      });
    } catch {
      return refuse(401, "invalid_signature");
    }

    const parsed = parseSlackBody(text, input.contentType);
    if (!parsed) return refuse(400, "malformed_body");
    if (parsed.kind === "ssl_check") return EMPTY_OK;

    const { body } = parsed;
    // Slack sends this when the operator saves the URL, before any identity exists.
    if (parsed.kind === "json" && body.type === "url_verification") {
      return typeof body.challenge === "string"
        ? jsonResult(200, { challenge: body.challenge })
        : refuse(400, "malformed_body");
    }
    // Control envelopes such as app_rate_limited carry no work.
    if (parsed.kind === "json" && body.type !== "event_callback") return EMPTY_OK;

    const identity = getCachedSlackWorkspaceIdentity();
    const app = this.app;
    if (!identity || !app || !this.ready) {
      return refuse(503, "workspace_unverified", { "Retry-After": RETRY_AFTER_SEC });
    }
    const ownership = checkInboundWorkspace(body, identity);
    if (!ownership.own) {
      recordSlackInboundWithheld("http", ownership.reason);
      return refuse(403, "foreign_workspace");
    }

    const retryNum = parseRetryNum(input.retryNum);
    const retryReason = input.retryReason?.slice(0, 128) || null;
    if (parsed.kind === "live") return this.runLive(app, body, retryNum, retryReason);
    return this.admitEvent(app, text, body, retryNum, retryReason);
  }

  private async admitEvent(
    app: App,
    rawBody: string,
    body: Record<string, unknown>,
    retryNum: number | null,
    retryReason: string | null,
  ): Promise<SlackHttpResult> {
    try {
      if (isOrderDependentEvent(body)) {
        // Last write wins, so it never waits in the queue: run it now and keep
        // only its dedup key. A store failure costs the restart protection, not the event.
        const stored = await recordSlackEventRanInline("http", body, {
          retryNum,
          retryReason,
        }).catch(() => "invalid" as const);
        if (stored !== "duplicate") {
          void app
            .processEvent({
              body,
              ack: async () => {},
              retryNum: retryNum ?? undefined,
              retryReason: retryReason ?? undefined,
            })
            .catch((error: unknown) => logDispatchError(error));
        }
        return EMPTY_OK;
      }
      const result = await admitSlackInbound({
        transport: "http",
        kind: "event",
        rawBody,
        body,
        retryNum,
        retryReason,
      });
      switch (result.status) {
        case "admitted":
          this.onAdmitted();
          return EMPTY_OK;
        case "duplicate":
          return EMPTY_OK;
        case "invalid":
          return refuse(400, result.reason);
        case "rejected":
          return result.reason === "payload_too_large"
            ? refuse(413, "payload_too_large")
            : refuse(503, "backlog_full", { "Retry-After": RETRY_AFTER_SEC });
      }
    } catch (error) {
      // Not stored, so not acked: Slack retries the event.
      console.error(`[Slack] HTTP event could not be stored: ${scrubSecrets(String(error))}`);
      return refuse(503, "store_unavailable", { "Retry-After": RETRY_AFTER_SEC });
    }
  }

  /**
   * Run a command or interactive payload through Bolt and answer with what its
   * handler acks. A handler that does not ack in time gets an empty 200 (Slack
   * would otherwise show the user a timeout); the handler keeps running.
   */
  private runLive(
    app: App,
    body: Record<string, unknown>,
    retryNum: number | null,
    retryReason: string | null,
  ): Promise<SlackHttpResult> {
    return new Promise<SlackHttpResult>((resolve) => {
      const timer = setTimeout(() => {
        console.warn("[Slack] HTTP handler did not ack in time; answered an empty 200");
        resolve(EMPTY_OK);
      }, SLACK_HTTP_ACK_TIMEOUT_MS);
      const ack: AckFn<unknown> = async (response) => {
        clearTimeout(timer);
        resolve(ackResult(response));
      };
      app
        .processEvent({
          body,
          ack,
          retryNum: retryNum ?? undefined,
          retryReason: retryReason ?? undefined,
        })
        .then(() => {
          // Settled with no ack (no listener matched): do not hold the request.
          clearTimeout(timer);
          resolve(EMPTY_OK);
        })
        .catch((error: unknown) => {
          clearTimeout(timer);
          logDispatchError(error);
          resolve(refuse(500, "handler_failed"));
        });
    });
  }
}

function logDispatchError(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[Slack] HTTP dispatch failed: ${scrubSecrets(message)}`);
}
