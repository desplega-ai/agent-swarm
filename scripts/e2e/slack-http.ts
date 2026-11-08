import { SlackMock, slackSignature } from "@desplega.ai/slack-mock";
import type { ScenarioContext } from "./run";
import { repoRoot } from "./sut";

export type HttpSlackOptions = {
  /** Where signed events, commands and interactivity are posted. */
  eventsUrl: string;
  signingSecret: string;
  /** Fixed port, so the SUT can be pointed at the mock's Web API before the mock exists. Default: any free port. */
  port?: number;
};

/**
 * A SlackMock that delivers as signed HTTP requests (Slack's HTTP mode) instead of over
 * Socket Mode. It holds no global state, so it runs next to the Socket mock the run started.
 * Retries are short so a failed delivery surfaces inside a scenario's timeout.
 */
export function startHttpSlackMock(options: HttpSlackOptions): Promise<SlackMock> {
  return SlackMock.start({
    port: options.port ?? 0,
    manifest: `${repoRoot}/slack-manifest.json`,
    httpDelivery: {
      eventsUrl: options.eventsUrl,
      signingSecret: options.signingSecret,
      retryDelaysMs: [300, 600],
      timeoutMs: 3_000,
    },
  });
}

/** The scenario context with `slack` swapped, so every ctx.slack helper drives `mock`. */
export function withSlack(ctx: ScenarioContext, mock: SlackMock): ScenarioContext {
  return { ...ctx, slack: mock };
}

/**
 * Count the mock's acked deliveries as raw requests to `path`, so route coverage sees
 * traffic that did not go through `ctx.api`.
 */
export function recordDeliveries(ctx: ScenarioContext, mock: SlackMock, path: string): void {
  // shortcut: counts every acked delivery as 200, the mock records no status; upgrade with DeliveryRecord.requests.
  for (const delivery of mock.deliveries()) {
    if (delivery.acked) ctx.recordHttpCall("POST", path, 200);
  }
}

export type SignedPostOptions = {
  /** Seconds since the epoch for `X-Slack-Request-Timestamp`; default now. */
  timestamp?: number;
  /** Sign with this secret instead of `secret`, to forge a bad signature. */
  signWith?: string;
  /** Leave the signature and timestamp headers off. */
  unsigned?: boolean;
  contentType?: string;
  headers?: Record<string, string>;
};

/**
 * One raw Slack-style request, for the cases the mock never produces itself: forged,
 * stale or unsigned requests and hand-built redeliveries with `X-Slack-Retry-*`.
 * The call goes straight to the SUT, so the caller counts it toward route coverage.
 */
export async function postSigned(
  ctx: ScenarioContext,
  url: string,
  secret: string,
  body: string,
  options: SignedPostOptions = {},
): Promise<Response> {
  const timestamp = String(options.timestamp ?? Math.floor(Date.now() / 1000));
  const headers: Record<string, string> = {
    "Content-Type": options.contentType ?? "application/json",
    ...options.headers,
  };
  if (!options.unsigned) {
    headers["X-Slack-Request-Timestamp"] = timestamp;
    headers["X-Slack-Signature"] = slackSignature(options.signWith ?? secret, timestamp, body);
  }
  const started = performance.now();
  const response = await fetch(url, { method: "POST", headers, body });
  ctx.recordHttpCall("POST", new URL(url).pathname, response.status, performance.now() - started);
  return response;
}

export type CapturedDelivery = {
  body: string;
  contentType: string;
  /** The SUT's real status; 0 when the forward failed. */
  status: number;
  durationMs: number;
};

export type CaptureProxy = {
  url: string;
  deliveries: CapturedDelivery[];
  stop: () => void;
};

/**
 * A pass-through between the mock and the SUT. The mock records no status code, timing or
 * body, so this keeps each delivery's raw body (to replay it as a Slack retry), the real
 * status and the SUT's response time, which the transport checks and route coverage read.
 */
export function startCaptureProxy(targetUrl: string): CaptureProxy {
  const deliveries: CapturedDelivery[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const body = await request.text();
      const contentType = request.headers.get("content-type") ?? "";
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const started = performance.now();
      try {
        const response = await fetch(targetUrl, { method: request.method, headers, body });
        const payload = await response.text();
        deliveries.push({
          body,
          contentType,
          status: response.status,
          durationMs: performance.now() - started,
        });
        return new Response(payload, {
          status: response.status,
          headers: { "content-type": response.headers.get("content-type") ?? "text/plain" },
        });
      } catch {
        deliveries.push({ body, contentType, status: 0, durationMs: performance.now() - started });
        return new Response("proxy forward failed", { status: 502 });
      }
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/`,
    deliveries,
    stop: () => void server.stop(true),
  };
}
