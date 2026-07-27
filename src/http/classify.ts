import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getAgentById } from "../be/db";
import { ClassificationResultSchema, classify } from "../utils/internal-ai/classify";
import { scrubSecrets } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { json, jsonError } from "./utils";

const classifyRoute = route({
  method: "post",
  path: "/api/internal-ai/classify",
  pattern: ["api", "internal-ai", "classify"],
  operationId: "internal_ai_classify",
  summary: "Classify input with the internal structured-output AI utility",
  tags: ["Internal AI"],
  body: z.object({
    input: z.union([z.string(), z.record(z.string(), z.unknown())]),
    labels: z.array(z.string().min(1).max(200)).min(1).max(100),
    timeoutMs: z.number().int().positive().max(30_000).default(3_000),
  }),
  responses: {
    200: {
      description: "Classification result; null when classification fails or times out",
      schema: z.object({ result: ClassificationResultSchema.nullable() }),
    },
    400: { description: "Invalid request or missing X-Agent-ID" },
    404: { description: "Agent not found" },
  },
  auth: { apiKey: true, agentId: true },
  rbac: {
    ungated: "read-only internal-AI classification utility; agent-authenticated, mutates nothing",
  },
});

export async function handleClassify(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  agentId: string | undefined,
): Promise<boolean> {
  if (!classifyRoute.match(req.method, pathSegments)) return false;
  const parsed = await classifyRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;
  if (!agentId) {
    jsonError(res, "X-Agent-ID required for classification", 400);
    return true;
  }
  if (!getAgentById(agentId)) {
    jsonError(res, "Agent not found", 404);
    return true;
  }

  // Fail open: routing callers treat null as "no classification" — any
  // internal failure (template registry included) must surface as 200 null.
  let result = null;
  try {
    result = await classify(parsed.body.input, parsed.body.labels, {
      timeoutMs: parsed.body.timeoutMs,
    });
  } catch (err) {
    // Classification failures can echo the caller's prompt/input material back
    // in the message, so scrub at this logging egress.
    console.error(
      `[classify] failed: ${scrubSecrets(err instanceof Error ? err.message : String(err))}`,
    );
  }
  json(res, { result });
  return true;
}
