import type { IncomingMessage, ServerResponse } from "node:http";
import { getSlackHttpReceiver } from "../slack/app";
import { getSlackConfiguration } from "../slack/config";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, jsonError } from "./utils";

const slackEventsRoute = route({
  method: "post",
  path: "/api/integrations/slack/events",
  pattern: ["api", "integrations", "slack", "events"],
  summary:
    "Slack HTTP ingress (SLACK_MODE=http): Events API, slash commands and interactivity at one request URL",
  tags: ["Slack"],
  auth: { apiKey: false },
  rbac: {
    ungated:
      "Slack-signed request: HMAC v0 verified with SLACK_SIGNING_SECRET, with a 5-minute timestamp window, before any work",
  },
  responses: {
    200: {
      description: "Accepted",
      unstructured:
        "Slack ack payload: empty, the url_verification challenge, or a command/interactivity response body",
    },
    400: { description: "Malformed body after a valid signature" },
    401: { description: "Missing or invalid signature, or timestamp outside the 5-minute window" },
    403: { description: "Delivery for a workspace this swarm does not own" },
    404: { description: "Slack is disabled or not in HTTP mode" },
    413: { description: "Body exceeds 1 MiB" },
    503: {
      description: "Receiver not ready, workspace unverified, or backlog full; Slack retries",
    },
  },
});

/** Slack payloads are a few KB; the receipt store refuses anything above 1 MiB anyway. */
const SLACK_EVENTS_MAX_BODY_BYTES = 1024 * 1024;

function header(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

export async function handleSlackEvents(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (!slackEventsRoute.match(req.method, pathSegments)) return false;

  // Never open ingress under Socket Mode, or without credentials.
  const config = getSlackConfiguration();
  if (config.disabled || config.mode !== "http" || config.missingCredentials.length > 0) {
    jsonError(res, "Slack HTTP mode is not enabled", 404);
    return true;
  }
  const receiver = getSlackHttpReceiver();
  if (!receiver) {
    res.writeHead(503, { "Content-Type": "application/json", "Retry-After": "5" });
    res.end(JSON.stringify({ error: "Slack receiver is not ready" }));
    return true;
  }

  // Unauthenticated until the HMAC passes, so bound the body before buffering
  // it. An oversized stream is answered at once and drained without buffering.
  if (enforceContentLengthCap(req, res, SLACK_EVENTS_MAX_BODY_BYTES) === BODY_TOO_LARGE) {
    return true;
  }
  const chunks: Buffer[] = [];
  let receivedBytes = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) continue;
    receivedBytes += (chunk as Buffer).byteLength;
    if (receivedBytes > SLACK_EVENTS_MAX_BODY_BYTES) {
      tooLarge = true;
      chunks.length = 0;
      jsonError(res, `Payload too large (max ${SLACK_EVENTS_MAX_BODY_BYTES} bytes)`, 413);
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) return true;

  const result = await receiver.handle({
    rawBody: Buffer.concat(chunks),
    signature: header(req, "x-slack-signature"),
    timestamp: header(req, "x-slack-request-timestamp"),
    contentType: header(req, "content-type"),
    retryNum: header(req, "x-slack-retry-num"),
    retryReason: header(req, "x-slack-retry-reason"),
    // Read per request so a config reload takes effect; never stored or logged.
    signingSecret: process.env.SLACK_SIGNING_SECRET as string,
  });
  res.writeHead(result.status, {
    ...(result.contentType ? { "Content-Type": result.contentType } : {}),
    ...result.headers,
  });
  res.end(result.body);
  return true;
}
