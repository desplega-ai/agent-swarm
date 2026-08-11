/**
 * HTTP routes for Structured Meetings. REST surface mirrors the MCP tools:
 * create / list / get-detail / contribute / conclude, plus a templates
 * discovery endpoint. The attendance + conclusion gate is enforced in the db
 * layer (`concludeMeeting`), so these handlers stay thin.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import {
  addMeetingContribution,
  concludeMeeting,
  createMeeting,
  getMeeting,
  getMeetingDetail,
  listMeetings,
  MeetingConclusionError,
} from "../be/db";
import { getMeetingTemplate, listMeetingTemplates } from "../meetings/templates";
import {
  MeetingContributionSchema,
  MeetingDetailSchema,
  MeetingSchema,
  MeetingStatusSchema,
  MeetingTemplateSchema,
} from "../types";
import { route } from "./route-def";
import { jsonError } from "./utils";

// ─── Route Definitions ──────────────────────────────────────────────────────

const createMeetingRoute = route({
  method: "post",
  path: "/api/meetings",
  pattern: ["api", "meetings"],
  summary: "Open a structured meeting",
  tags: ["Meetings"],
  rbac: {
    ungated:
      "Collaboration primitive: any authenticated agent may open a meeting. The attendance + conclusion gate is the real control.",
  },
  body: z.object({
    title: z.string().min(1),
    agenda: z.string().min(1).optional(),
    template: z.string().optional(),
    participants: z.array(z.string().min(1)).min(1),
  }),
  responses: {
    201: { description: "Meeting created", schema: MeetingSchema },
    400: { description: "Invalid body or unknown template" },
  },
});

const listMeetingsRoute = route({
  method: "get",
  path: "/api/meetings",
  pattern: ["api", "meetings"],
  summary: "List meetings",
  tags: ["Meetings"],
  query: z.object({
    status: MeetingStatusSchema.optional(),
    agentId: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(500).optional(),
    offset: z.coerce.number().int().min(0).optional(),
  }),
  responses: {
    200: {
      description: "Meeting list",
      schema: z.object({
        meetings: z.array(MeetingSchema),
        limit: z.number().int(),
        offset: z.number().int(),
      }),
    },
  },
});

const listMeetingTemplatesRoute = route({
  method: "get",
  path: "/api/meetings/templates",
  pattern: ["api", "meetings", "templates"],
  summary: "List built-in meeting templates",
  tags: ["Meetings"],
  responses: {
    200: {
      description: "Template list",
      schema: z.object({ templates: z.array(MeetingTemplateSchema) }),
    },
  },
});

const getMeetingRoute = route({
  method: "get",
  path: "/api/meetings/{id}",
  pattern: ["api", "meetings", null],
  summary: "Get a meeting with contributions + attendance",
  tags: ["Meetings"],
  params: z.object({ id: z.string() }),
  responses: {
    200: { description: "Meeting detail", schema: MeetingDetailSchema },
    404: { description: "Meeting not found" },
  },
});

const contributeMeetingRoute = route({
  method: "post",
  path: "/api/meetings/{id}/contributions",
  pattern: ["api", "meetings", null, "contributions"],
  summary: "Record a contribution to a meeting",
  tags: ["Meetings"],
  rbac: {
    ungated:
      "Collaboration primitive: any authenticated agent may contribute to a meeting; identity is the caller's X-Agent-ID.",
  },
  params: z.object({ id: z.string() }),
  body: z.object({ content: z.string().min(1), round: z.number().int().min(1).optional() }),
  responses: {
    201: { description: "Contribution recorded", schema: MeetingContributionSchema },
    404: { description: "Meeting not found" },
    409: { description: "Meeting is not open" },
  },
});

const concludeMeetingRoute = route({
  method: "post",
  path: "/api/meetings/{id}/conclude",
  pattern: ["api", "meetings", null, "conclude"],
  summary: "Conclude a meeting (attendance + conclusion gate)",
  tags: ["Meetings"],
  rbac: {
    ungated:
      "Collaboration primitive: any participant may conclude; the attendance + conclusion gate in the db layer is the real control.",
  },
  params: z.object({ id: z.string() }),
  body: z.object({ conclusion: z.string().min(1) }),
  responses: {
    200: { description: "Meeting concluded", schema: MeetingDetailSchema },
    404: { description: "Meeting not found" },
    409: { description: "Gate not satisfied (attendance/state/empty conclusion)" },
  },
});

// ─── Handler ────────────────────────────────────────────────────────────────

export async function handleMeetings(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  // POST /api/meetings — create.
  if (createMeetingRoute.match(req.method, pathSegments)) {
    const parsed = await createMeetingRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!myAgentId) {
      jsonError(res, "X-Agent-ID header required", 400);
      return true;
    }
    let agenda = parsed.body.agenda?.trim();
    if (parsed.body.template) {
      const tpl = getMeetingTemplate(parsed.body.template);
      if (!tpl) {
        jsonError(res, `Unknown template "${parsed.body.template}"`, 400);
        return true;
      }
      agenda = agenda || tpl.agenda;
    }
    if (!agenda) {
      jsonError(res, "An agenda is required (pass `agenda` or a `template`)", 400);
      return true;
    }
    const meeting = createMeeting({
      agentId: myAgentId,
      title: parsed.body.title,
      agenda,
      template: parsed.body.template,
      participants: parsed.body.participants,
    });
    createMeetingRoute.respond(res, 201, meeting);
    return true;
  }

  // GET /api/meetings/templates — MUST come before getMeetingRoute (the
  // `null` slot would otherwise capture "templates" as a meeting id).
  if (listMeetingTemplatesRoute.match(req.method, pathSegments)) {
    listMeetingTemplatesRoute.respond(res, 200, { templates: listMeetingTemplates() });
    return true;
  }

  // GET /api/meetings — list. MUST come before getMeetingRoute (shorter pattern).
  if (listMeetingsRoute.match(req.method, pathSegments)) {
    const parsed = await listMeetingsRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const limit = parsed.query.limit ?? 100;
    const offset = parsed.query.offset ?? 0;
    const meetings = listMeetings({
      status: parsed.query.status,
      agentId: parsed.query.agentId,
      limit,
      offset,
    });
    listMeetingsRoute.respond(res, 200, { meetings, limit, offset });
    return true;
  }

  // POST /api/meetings/{id}/contributions — contribute.
  if (contributeMeetingRoute.match(req.method, pathSegments)) {
    const parsed = await contributeMeetingRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!myAgentId) {
      jsonError(res, "X-Agent-ID header required", 400);
      return true;
    }
    if (!getMeeting(parsed.params.id)) {
      jsonError(res, "Meeting not found", 404);
      return true;
    }
    try {
      const contribution = addMeetingContribution({
        meetingId: parsed.params.id,
        agentId: myAgentId,
        content: parsed.body.content,
        round: parsed.body.round,
      });
      contributeMeetingRoute.respond(res, 201, contribution);
    } catch (err) {
      if (err instanceof MeetingConclusionError) {
        jsonError(res, err.message, 409);
        return true;
      }
      throw err;
    }
    return true;
  }

  // POST /api/meetings/{id}/conclude — conclude (gated).
  if (concludeMeetingRoute.match(req.method, pathSegments)) {
    const parsed = await concludeMeetingRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    if (!myAgentId) {
      jsonError(res, "X-Agent-ID header required", 400);
      return true;
    }
    if (!getMeeting(parsed.params.id)) {
      jsonError(res, "Meeting not found", 404);
      return true;
    }
    try {
      const detail = concludeMeeting({
        meetingId: parsed.params.id,
        agentId: myAgentId,
        conclusion: parsed.body.conclusion,
      });
      concludeMeetingRoute.respond(res, 200, detail);
    } catch (err) {
      if (err instanceof MeetingConclusionError) {
        jsonError(res, err.message, 409);
        return true;
      }
      throw err;
    }
    return true;
  }

  // GET /api/meetings/{id} — detail. Checked last (broadest GET pattern).
  if (getMeetingRoute.match(req.method, pathSegments)) {
    const parsed = await getMeetingRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const detail = getMeetingDetail(parsed.params.id);
    if (!detail) {
      jsonError(res, "Meeting not found", 404);
      return true;
    }
    getMeetingRoute.respond(res, 200, detail);
    return true;
  }

  return false;
}
