import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getTaskById } from "../be/db";
import {
  createRequestComposition,
  getRequestCompositionsByTask,
  MAX_REQUEST_COMPOSITIONS_PER_TASK,
} from "../be/db/request-composition";
import { estimateTokens } from "../be/memory/key-browser";
import {
  type RequestCompositionPart,
  RequestCompositionPartInputSchema,
  RequestCompositionSchema,
  type RequestCompositionToolLoading,
  RequestCompositionToolLoadingSchema,
} from "../types";
import { resolveMcpSessionOptions } from "./mcp";
import { route } from "./route-def";
import { listSessionToolsMemo, measureToolSchemas } from "./tool-schema-estimate";
import { jsonError } from "./utils";

// ─── Response Schemas ───────────────────────────────────────────────────────

const PostRequestCompositionResponseSchema = z.object({
  ok: z.literal(true),
  id: z.uuid(),
  seq: z.number().int().min(0),
});

const GetRequestCompositionResponseSchema = z.object({
  manifests: z.array(RequestCompositionSchema),
});

// ─── Route Definitions ───────────────────────────────────────────────────────

const postRequestComposition = route({
  method: "post",
  path: "/api/tasks/{id}/request-composition",
  pattern: ["api", "tasks", null, "request-composition"],
  session: { taskParam: "id" },
  rbac: {
    ungated: "worker session telemetry, same posture as POST /api/tasks/{id}/context",
  },
  summary: "Record the request composition manifest of a task session",
  description:
    "The worker posts the size of each prompt part it assembled. The server adds the MCP tool-schema estimate for the agent's effective tool surface and stores the manifest as the session's next seq. Only the agent assigned to the task may post, and a task keeps at most 100 manifests.",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().optional(),
    toolLoading: RequestCompositionToolLoadingSchema,
    parts: z.array(RequestCompositionPartInputSchema).max(200),
  }),
  responses: {
    200: { description: "Manifest recorded", schema: PostRequestCompositionResponseSchema },
    400: { description: "Validation error" },
    403: { description: "Task is assigned to another agent" },
    404: { description: "Task not found" },
    429: { description: "The task already holds the maximum number of manifests" },
  },
  auth: { apiKey: true, agentId: true },
});

const getRequestComposition = route({
  method: "get",
  path: "/api/tasks/{id}/request-composition",
  pattern: ["api", "tasks", null, "request-composition"],
  session: { taskParam: "id" },
  summary: "Get the request composition manifests of a task",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  query: z.object({
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MAX_REQUEST_COMPOSITIONS_PER_TASK)
      .default(MAX_REQUEST_COMPOSITIONS_PER_TASK),
  }),
  responses: {
    200: { description: "Manifests, oldest first", schema: GetRequestCompositionResponseSchema },
    404: { description: "Task not found" },
  },
  auth: { apiKey: true },
});

// ─── Tool schemas ────────────────────────────────────────────────────────────

const TOOL_SCHEMA_LABELS: Record<Exclude<RequestCompositionToolLoading, "none">, string> = {
  all: "swarm tool schemas",
  core: "swarm tool schemas (core + preloaded; deferred tools load into history)",
  preloaded: "swarm tool schemas (preloaded only; deferred tools load into history)",
};

/**
 * Estimate the swarm MCP tool schemas the harness sends with every call. The
 * surface inputs (tool allowlist, capabilities, scripts-only, task manifests)
 * are resolved server-side exactly as an MCP session resolves them; the
 * loading mode is the worker's report. A failure drops the part, not the post.
 */
async function toolSchemaPart(
  agentId: string,
  task: NonNullable<Awaited<ReturnType<typeof getTaskById>>>,
  loading: RequestCompositionToolLoading,
): Promise<RequestCompositionPart | null> {
  if (loading === "none") return null;
  try {
    const tools = await listSessionToolsMemo(await resolveMcpSessionOptions(agentId, task));
    const { chars } = measureToolSchemas(tools, loading);
    return {
      kind: "tool_schemas",
      id: "mcp:agent-swarm",
      label: TOOL_SCHEMA_LABELS[loading],
      chars,
      estTokens: estimateTokens(chars),
      fidelity: "estimate",
    };
  } catch (err) {
    console.warn(
      `[request-composition] Tool schema estimate failed: ${err instanceof Error ? err.message : err}`,
    );
    return null;
  }
}

// ─── Handler ─────────────────────────────────────────────────────────────────

export async function handleRequestComposition(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (postRequestComposition.match(req.method, pathSegments)) {
    if (!myAgentId) {
      jsonError(res, "Missing X-Agent-ID header", 400);
      return true;
    }

    const parsed = await postRequestComposition.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const task = await getTaskById(parsed.params.id);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }
    if (task.agentId !== myAgentId) {
      jsonError(res, "Task is assigned to another agent", 403);
      return true;
    }

    const parts: RequestCompositionPart[] = parsed.body.parts.map((part) => ({
      ...part,
      estTokens: estimateTokens(part.chars),
    }));
    const toolPart = await toolSchemaPart(myAgentId, task, parsed.body.toolLoading);
    if (toolPart) parts.push(toolPart);

    const manifest = await createRequestComposition({
      taskId: task.id,
      agentId: myAgentId,
      sessionId: parsed.body.sessionId,
      provider: parsed.body.provider,
      model: parsed.body.model,
      source: "worker",
      parts,
    });
    if (!manifest) {
      jsonError(
        res,
        `Task already holds ${MAX_REQUEST_COMPOSITIONS_PER_TASK} request composition manifests`,
        429,
      );
      return true;
    }

    postRequestComposition.respond(res, 200, { ok: true, id: manifest.id, seq: manifest.seq });
    return true;
  }

  if (getRequestComposition.match(req.method, pathSegments)) {
    const parsed = await getRequestComposition.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;

    const task = await getTaskById(parsed.params.id);
    if (!task) {
      jsonError(res, "Task not found", 404);
      return true;
    }

    const manifests = await getRequestCompositionsByTask(task.id, parsed.query.limit);
    getRequestComposition.respond(res, 200, { manifests });
    return true;
  }

  return false;
}
