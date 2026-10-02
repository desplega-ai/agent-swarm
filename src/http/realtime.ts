import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getCombConfig } from "../comb/config";
import { can } from "../rbac";
import bundle from "../realtime/browser.generated.txt" with { type: "text" };
import { issueRealtimeTicket } from "../realtime/tickets";
import { getRequestAuth } from "../utils/request-auth-context";
import { route } from "./route-def";
import { jsonError } from "./utils";

const realtimeTicketRoute = route({
  method: "post",
  path: "/api/realtime/ticket",
  pattern: ["api", "realtime", "ticket"],
  summary: "Issue a one-shot dashboard realtime ticket",
  tags: ["Rooms"],
  rbac: { permission: "comb.presence" },
  responses: {
    200: {
      description: "One-shot realtime ticket",
      schema: z.object({ ticket: z.string(), expiresAt: z.number().int() }),
    },
    403: { description: "Comb presence is not allowed" },
    404: { description: "Comb is not enabled" },
  },
});

route({
  method: "get",
  path: "/@swarm/realtime.js",
  pattern: ["@swarm", "realtime.js"],
  summary: "Browser SDK for realtime rooms and channels",
  tags: ["Pages"],
  auth: { apiKey: false },
  responses: {
    200: { description: "JavaScript module", unstructured: "Browser JavaScript bundle" },
  },
});

/** `POST /api/realtime/ticket`: a one-shot ticket for a dashboard realtime socket (Comb presence). */
export async function handleRealtimeTicket(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!realtimeTicketRoute.match(req.method, pathSegments)) return false;
  // Comb presence is the only ticket consumer, so the route is off with Comb.
  if (!getCombConfig().enabled) {
    jsonError(res, "Comb is not enabled", 404);
    return true;
  }
  const parsed = await realtimeTicketRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const auth = getRequestAuth(req);
  if (!auth || auth.kind === "agent") {
    jsonError(res, "Comb presence requires dashboard authentication", 403);
    return true;
  }
  const principal =
    auth.kind === "operator"
      ? ({ kind: "operator" } as const)
      : ({ kind: "user", userId: auth.userId } as const);
  if (
    !can({
      principal,
      verb: "comb.presence",
      resource: { kind: "none" },
      source: "http",
    }).allow
  ) {
    jsonError(res, "Comb presence requires the comb.presence permission", 403);
    return true;
  }
  realtimeTicketRoute.respond(res, 200, issueRealtimeTicket(auth));
  return true;
}

export async function handleRealtimeAsset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  if (req.method !== "GET" || req.url?.split("?")[0] !== "/@swarm/realtime.js") return false;
  res.writeHead(200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  res.end(bundle);
  return true;
}
