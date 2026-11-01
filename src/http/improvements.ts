import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  approveAndSend,
  createImprovement,
  discardImprovement,
  getImprovement,
  IMPROVEMENT_SOURCES,
  IMPROVEMENT_STATUSES,
  IMPROVEMENT_TEXT_MAX,
  type Improvement,
  ImprovementError,
  improvementLeakHints,
  isImprovementsEnabled,
  listImprovements,
} from "../be/improvements";
import { can } from "../rbac";
import { approvalResponder, responderKey } from "./person-responder";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { telemetryProxyEndpoint } from "./used-by";
import { jsonError } from "./utils";

// ─── Schemas ─────────────────────────────────────────────────────────────────

const ImprovementSchema = z.object({
  id: z.string(),
  text: z.string(),
  email: z.string().nullable(),
  status: z.enum(IMPROVEMENT_STATUSES),
  source: z.enum(IMPROVEMENT_SOURCES),
  requestedByAgentId: z.string().nullable(),
  approvedBy: z.string().nullable(),
  approvedAt: z.string().nullable(),
  sentAt: z.string().nullable(),
  proxyStatus: z.number().nullable(),
  proxyId: z.string().nullable(),
  proxyError: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  leakHints: z
    .array(z.string())
    .optional()
    .describe(
      "Substrings that look install-specific (agent, repo, host, org or user email). Pending and failed rows only. They warn; they never block.",
    ),
});

const EmailSchema = z
  .string()
  .max(320, "Email must be at most 320 characters")
  .email("Email must be a valid email address");

const PERSON_REFUSED =
  "Agents cannot approve improvements. A person must approve with a user token or the dashboard.";

// ─── Route Definitions ───────────────────────────────────────────────────────

const listRoute = route({
  method: "get",
  path: "/api/improvements",
  pattern: ["api", "improvements"],
  summary: "List product improvements",
  description:
    "Lists drafted and sent improvements, newest first, with `enabled` for the `IMPROVEMENTS_ENABLED` switch. Pending and failed rows carry `leakHints` for the approver.",
  tags: ["Improvements"],
  responses: {
    200: {
      description: "Improvements and the switch state",
      schema: z.object({ enabled: z.boolean(), improvements: z.array(ImprovementSchema) }),
    },
  },
  auth: { apiKey: true },
});

const createRoute = route({
  method: "post",
  path: "/api/improvements",
  pattern: ["api", "improvements"],
  summary: "Draft a product improvement, or send one as a person",
  description:
    "Stores the text, scrubbed of known secrets, as `pending_approval`. An agent caller always gets a pending draft. A person (user token, or the shared key with no agent identity) may pass `sendNow: true` to approve and send in one call, unless scrubbing changed the text: then it stays pending so they can review it. Only `install_id` (while telemetry is on), `text` and `email` are sent to desplega.",
  tags: ["Improvements"],
  body: z.object({
    text: z.string().max(IMPROVEMENT_TEXT_MAX * 2),
    email: EmailSchema.optional(),
    sendNow: z.boolean().optional(),
    source: z.enum(["ui", "api"]).optional(),
  }),
  responses: {
    200: {
      description: "A person's `sendNow` was approved and sent (see `status`)",
      schema: z.object({ improvement: ImprovementSchema }),
    },
    201: {
      description: "Draft stored as `pending_approval`",
      schema: z.object({ improvement: ImprovementSchema }),
    },
    400: { description: "Invalid text or email" },
    403: { description: "The caller may not draft improvements" },
    409: { description: "Improvements are turned off" },
  },
  auth: { apiKey: true },
  rbac: { permission: "improvement.submit" },
});

const approveRoute = route({
  method: "post",
  path: "/api/improvements/{id}/approve",
  pattern: ["api", "improvements", null, "approve"],
  summary: "Approve and send a drafted improvement",
  description:
    "Only a person may approve: a user token, or the shared key with no agent identity (recorded as `operator`). `approvedBy` is taken from the credential, never the body. The stored text is sent as is; to change it, discard and draft again. A failed send can be approved again. There is no automatic retry.",
  tags: ["Improvements"],
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ email: EmailSchema.nullable().optional() }),
  responses: {
    200: {
      description: "Approved. `status` is `sent`, or `failed` with the proxy status and error.",
      schema: z.object({ improvement: ImprovementSchema }),
    },
    403: { description: "Caller is an agent" },
    404: { description: "Not found" },
    409: { description: "Already sent, sending or discarded, or improvements are turned off" },
  },
  auth: { apiKey: true },
  rbac: { permission: "improvement.approve" },
});

const discardRoute = route({
  method: "post",
  path: "/api/improvements/{id}/discard",
  pattern: ["api", "improvements", null, "discard"],
  summary: "Discard a drafted improvement",
  description:
    "A person may discard any pending or failed improvement. An agent may discard only a draft it requested.",
  tags: ["Improvements"],
  params: z.object({ id: z.string().uuid() }),
  responses: {
    200: {
      description: "Discarded",
      schema: z.object({ improvement: ImprovementSchema }),
    },
    403: { description: "Caller is an agent that did not request this draft" },
    404: { description: "Not found" },
    409: { description: "Already sent or discarded, or improvements are turned off" },
  },
  auth: { apiKey: true },
  rbac: { permission: "improvement.submit" },
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function headerAgentId(req: IncomingMessage): string | undefined {
  const raw = req.headers["x-agent-id"];
  return Array.isArray(raw) ? raw[0] : raw;
}

function writeImprovementError(res: ServerResponse, error: unknown): boolean {
  if (!(error instanceof ImprovementError)) return false;
  const status =
    error.code === "invalid_text"
      ? 400
      : error.code === "not_found"
        ? 404
        : 409; /* conflict, improvements_disabled */
  if (error.code === "improvements_disabled") {
    res.writeHead(409, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: error.message, code: error.code }));
    return true;
  }
  jsonError(res, error.message, status);
  return true;
}

async function withLeakHints(improvement: Improvement) {
  if (improvement.status !== "pending_approval" && improvement.status !== "failed") {
    return improvement;
  }
  return { ...improvement, leakHints: await improvementLeakHints(improvement.text) };
}

async function improvementsEndpoint(): Promise<string> {
  return telemetryProxyEndpoint("/v1/improvements");
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleImprovements(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (listRoute.match(req.method, pathSegments)) {
    const parsed = await listRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const rows = await listImprovements();
    listRoute.respond(res, 200, {
      enabled: await isImprovementsEnabled(),
      improvements: await Promise.all(rows.map(withLeakHints)),
    });
    return true;
  }

  if (createRoute.match(req.method, pathSegments)) {
    const parsed = await createRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { text, email, sendNow, source } = parsed.body;
    const principal = await agentFirstPrincipal(req, headerAgentId(req));
    const decision = can({ principal, verb: "improvement.submit", source: "http" });
    if (!decision.allow) {
      jsonError(res, decision.reason, 403);
      return true;
    }
    const agentId = principal.kind === "agent" ? principal.agentId || null : null;
    const userId = principal.kind === "user" ? principal.userId : null;
    try {
      const { improvement, scrubChanged } = await createImprovement({
        text,
        source: source ?? "api",
        requestedByAgentId: agentId,
        createdBy: userId,
      });
      // The send needs a person from the credential. An agent's `sendNow` is
      // ignored: its draft waits for a person.
      if (sendNow && !scrubChanged) {
        const person = await approvalResponder(req, {
          verb: "improvement.approve",
          refusedMessage: PERSON_REFUSED,
        });
        if (person.ok) {
          const sent = await approveAndSend(improvement.id, {
            approvedBy: responderKey(person.responder),
            email: email ?? null,
            endpoint: await improvementsEndpoint(),
            updatedBy: person.responder.kind === "user" ? person.responder.user.id : null,
          });
          createRoute.respond(res, 200, { improvement: sent });
          return true;
        }
      }
      createRoute.respond(res, 201, { improvement: await withLeakHints(improvement) });
    } catch (error) {
      if (!writeImprovementError(res, error)) throw error;
    }
    return true;
  }

  if (approveRoute.match(req.method, pathSegments)) {
    const parsed = await approveRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const person = await approvalResponder(req, {
      verb: "improvement.approve",
      refusedMessage: PERSON_REFUSED,
      pageMessage: "A page session without a signed-in user cannot approve improvements.",
    });
    if (!person.ok) {
      jsonError(res, person.message, 403);
      return true;
    }
    try {
      const improvement = await approveAndSend(parsed.params.id, {
        approvedBy: responderKey(person.responder),
        email: parsed.body.email ?? null,
        endpoint: await improvementsEndpoint(),
        updatedBy: person.responder.kind === "user" ? person.responder.user.id : null,
      });
      approveRoute.respond(res, 200, { improvement });
    } catch (error) {
      if (!writeImprovementError(res, error)) throw error;
    }
    return true;
  }

  if (discardRoute.match(req.method, pathSegments)) {
    const parsed = await discardRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const existing = await getImprovement(parsed.params.id);
    if (!existing) {
      jsonError(res, "Improvement not found", 404);
      return true;
    }
    const principal = await agentFirstPrincipal(req, headerAgentId(req));
    let updatedBy: string | null = null;
    if (principal.kind === "agent") {
      if (!principal.agentId || principal.agentId !== existing.requestedByAgentId) {
        jsonError(res, "An agent may discard only an improvement it drafted.", 403);
        return true;
      }
    } else {
      const person = await approvalResponder(req, {
        verb: "improvement.approve",
        refusedMessage: "Only a person or the drafting agent may discard this improvement.",
      });
      if (!person.ok) {
        jsonError(res, person.message, 403);
        return true;
      }
      updatedBy = person.responder.kind === "user" ? person.responder.user.id : null;
    }
    try {
      const improvement = await discardImprovement(parsed.params.id, { updatedBy });
      discardRoute.respond(res, 200, { improvement });
    } catch (error) {
      if (!writeImprovementError(res, error)) throw error;
    }
    return true;
  }

  return false;
}
