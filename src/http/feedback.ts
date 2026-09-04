import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { createFeedbackSubmission, relayPendingFeedback } from "../feedback";
import { route } from "./route-def";
import { jsonError } from "./utils";

const createFeedbackRoute = route({
  method: "post",
  path: "/api/feedback",
  pattern: ["api", "feedback"],
  summary: "Store an explicit feedback submission and queue it for relay",
  tags: ["Feedback"],
  body: z.object({
    name: z.string().trim().max(200).optional(),
    email: z.string().trim().email().max(320).optional(),
    newsletter_consent: z.boolean(),
    nps: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]).optional(),
    message: z.string().trim().max(10_000).optional(),
    user_id: z.string().min(1),
  }),
  responses: {
    202: {
      description: "Feedback stored locally and queued for relay",
      schema: z.object({ success: z.literal(true), submission_id: z.string() }),
    },
    400: { description: "Validation error" },
    401: { description: "Unauthorized" },
    500: { description: "Persistence error" },
  },
  auth: { apiKey: true },
  rbac: {
    ungated:
      "self-scoped: any authenticated console user submits their own feedback; no role or permission is implied",
  },
});

export async function handleFeedback(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
): Promise<boolean> {
  if (!createFeedbackRoute.match(req.method, pathSegments)) return false;
  const parsed = await createFeedbackRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  try {
    const submissionId = await createFeedbackSubmission(parsed.body);
    createFeedbackRoute.respond(res, 202, { success: true, submission_id: submissionId });
    void relayPendingFeedback().catch((error) => {
      console.warn(
        `[feedback] Immediate relay sweep failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
  } catch (error) {
    console.error("[feedback] Failed to persist submission:", error);
    jsonError(res, "Failed to store feedback", 500);
  }
  return true;
}
