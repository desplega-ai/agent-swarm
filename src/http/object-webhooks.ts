import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { handleObjectWebhookEvent, objectWebhookSecret } from "../be/primitives/object-webhooks";
import { decodeStandardWebhookSecret, verifyStandardWebhookSignature } from "../workflows/triggers";
import { route } from "./route-def";
import { BODY_TOO_LARGE, enforceContentLengthCap, jsonError } from "./utils";

/** A `file.changed` envelope is metadata only (a few hundred bytes). */
const MAX_BODY_BYTES = 64 * 1024;

const objectWebhook = route({
  method: "post",
  path: "/api/objects/agent-fs-webhook/{id}",
  pattern: ["api", "objects", "agent-fs-webhook", null],
  summary: "Receive agent-fs file.changed events that keep primitive objects in sync",
  tags: ["Webhooks"],
  params: z.object({ id: z.string().describe("Receiver id the swarm registered with agent-fs") }),
  auth: { apiKey: false },
  rbac: {
    ungated:
      "provider webhook: authenticated by the per-drive Standard Webhooks HMAC secret the swarm registered with agent-fs, not a swarm principal",
  },
  responses: {
    200: {
      description: "Event applied or ignored",
      schema: z.object({
        action: z.enum(["updated", "tombstoned", "restored", "moved", "ignored"]),
        path: z.string(),
        id: z.string().optional(),
        reason: z.string().optional(),
      }),
    },
    400: { description: "Body is not a valid event" },
    401: { description: "Unknown receiver, missing headers or invalid signature" },
    413: { description: "Body exceeds 64 KiB" },
    503: { description: "agent-fs could not be read; agent-fs retries the delivery" },
  },
});

const header = (req: IncomingMessage, name: string): string | undefined => {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

export async function handleObjectWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
): Promise<boolean> {
  if (!objectWebhook.match(req.method, pathSegments)) return false;
  if (enforceContentLengthCap(req, res, MAX_BODY_BYTES) === BODY_TOO_LARGE) return true;

  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of req) {
    received += (chunk as Buffer).byteLength;
    if (received > MAX_BODY_BYTES) {
      jsonError(res, `Payload too large (max ${MAX_BODY_BYTES} bytes)`, 413);
      req.resume();
      return true;
    }
    chunks.push(chunk as Buffer);
  }
  const rawBody = Buffer.concat(chunks).toString("utf-8");

  // Standard Webhooks: HMAC over "{id}.{timestamp}.{body}", timestamp within
  // 5 minutes. A replay inside that window is a no-op: events apply only above
  // the row's stored file version.
  const id = header(req, "webhook-id");
  const timestamp = header(req, "webhook-timestamp");
  const signature = header(req, "webhook-signature");
  const hook = await objectWebhookSecret(pathSegments[3] ?? "");
  const key = hook ? decodeStandardWebhookSecret(hook.secret) : null;
  if (
    !hook ||
    !key ||
    !id ||
    !timestamp ||
    !signature ||
    !verifyStandardWebhookSignature(key, rawBody, { id, timestamp, signature })
  ) {
    jsonError(res, "Invalid webhook signature", 401);
    return true;
  }

  let envelope: unknown;
  try {
    envelope = JSON.parse(rawBody);
  } catch {
    jsonError(res, "Invalid JSON body", 400);
    return true;
  }

  const outcome = await handleObjectWebhookEvent(hook, envelope);
  if (outcome.status === 200) {
    objectWebhook.respond(res, 200, outcome.result);
  } else {
    jsonError(res, outcome.error, outcome.status);
  }
  return true;
}
