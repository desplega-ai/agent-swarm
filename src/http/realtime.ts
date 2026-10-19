import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { findUserById } from "../be/users";
import { can } from "../rbac";
import bundle from "../realtime/browser.generated.txt" with { type: "text" };
import { issueRealtimeTicket } from "../realtime/tickets";
import { getRequestAuth } from "../utils/request-auth-context";
import { dashboardUserIdHeader } from "./favorite-owner";
import { route } from "./route-def";
import { jsonError } from "./utils";

const realtimeTicketRoute = route({
  method: "post",
  path: "/api/realtime/ticket",
  pattern: ["api", "realtime", "ticket"],
  summary: "Issue a one-shot dashboard realtime ticket",
  tags: ["Rooms"],
  description:
    "The ticket authorizes one dashboard socket for presence rooms: Comb drives (`comb.presence`) and sessions (`session.presence`). An operator-key tab's picked user (`X-Swarm-User-Id`) rides on the ticket so session presence can check that user's access.",
  // Comb presence came first; a role granting only `comb.presence` keeps its ticket.
  rbac: { permission: "session.presence", alsoAdmits: ["comb.presence"] },
  responses: {
    200: {
      description: "One-shot realtime ticket",
      schema: z.object({ ticket: z.string(), expiresAt: z.number().int() }),
    },
    403: { description: "Presence is not allowed" },
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

/** `POST /api/realtime/ticket`: a one-shot ticket for a dashboard realtime socket (presence rooms). */
export async function handleRealtimeTicket(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!realtimeTicketRoute.match(req.method, pathSegments)) return false;
  // Session presence needs the ticket with Comb off too; each room still
  // checks its own verb and access when the socket joins it.
  const parsed = await realtimeTicketRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  const auth = getRequestAuth(req);
  if (!auth || auth.kind === "agent" || auth.kind === "guest" || auth.kind === "controller") {
    jsonError(res, "Presence requires dashboard authentication", 403);
    return true;
  }
  const principal =
    auth.kind === "operator"
      ? ({ kind: "operator" } as const)
      : ({ kind: "user", userId: auth.userId } as const);
  const allowed = (verb: "comb.presence" | "session.presence") =>
    can({ principal, verb, resource: { kind: "none" }, source: "http" }).allow;
  if (!allowed("comb.presence") && !allowed("session.presence")) {
    jsonError(res, "Presence requires the comb.presence or session.presence permission", 403);
    return true;
  }
  let dashboardUserId: string | undefined;
  if (auth.kind === "operator" && !auth.page) {
    const picked = dashboardUserIdHeader(req);
    const user = picked ? await findUserById(picked) : null;
    if (user?.status === "active") dashboardUserId = user.id;
  }
  realtimeTicketRoute.respond(
    res,
    200,
    issueRealtimeTicket(dashboardUserId ? { ...auth, dashboardUserId } : auth),
  );
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
