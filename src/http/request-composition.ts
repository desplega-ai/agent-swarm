import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getTaskById } from "../be/db";
import {
  clampTokenRatio,
  createRequestComposition,
  getLatestWorkerComposition,
  getRequestCompositionsByTask,
  getTokenRatio,
  MAX_REQUEST_COMPOSITIONS_PER_TASK,
  recordTokenRatio,
} from "../be/db/request-composition";
import { estimateTokens } from "../be/memory/key-browser";
import {
  type RequestComposition,
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
    "The worker posts the size of each prompt part it assembled. The server adds the MCP tool-schema estimate for the agent's effective tool surface and stores the manifest as the session's next seq. A `harness-hook` post (pi, opencode) carries exact sizes measured from the request payload plus the call's prompt tokens: the server merges it with the session's worker manifest and folds the observed chars-to-tokens ratio into the provider's average. Only the agent assigned to the task may post, and a task keeps at most 100 manifests.",
  tags: ["Tasks"],
  params: z.object({ id: z.string() }),
  body: z.object({
    sessionId: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().optional(),
    toolLoading: RequestCompositionToolLoadingSchema,
    parts: z.array(RequestCompositionPartInputSchema).max(200),
    source: z.enum(["worker", "harness-hook"]).default("worker"),
    /** Required for `harness-hook`: totals measured from the request payload. */
    harness: z
      .object({
        systemChars: z.number().int().min(0),
        payloadChars: z.number().int().min(0),
        promptTokens: z.number().int().min(0),
        firstMessageChars: z.number().int().min(0).optional(),
      })
      .optional(),
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

// ─── Harness-hook manifests ──────────────────────────────────────────────────

/** Worker parts that are text inside the system prompt the harness sends. */
const SYSTEM_PROMPT_KINDS = new Set<RequestCompositionPart["kind"]>([
  "system_section",
  "persona",
  "claude_md",
  "operator_prompt",
]);

/**
 * Build a hook manifest's parts. The hook measured the whole system prompt,
 * the tool declarations and the skills listing exactly. The worker manifest
 * still names our sections, the task prompt and the memories, so they carry
 * over; the system prompt chars they do not cover are the harness's own base
 * prompt, now exact instead of a residual. On the session's first call the
 * message text beyond our task prompt and memories is context the harness
 * added (OpenCode's environment block, for one). Estimated tool schemas give
 * way to the measured ones. Without a worker manifest the system prompt stays
 * whole.
 */
export function mergeHookParts(
  hookParts: readonly RequestCompositionPart[],
  harness: { systemChars: number; firstMessageChars?: number },
  worker: RequestComposition | null,
): RequestCompositionPart[] {
  const exactPart = (id: string, label: string, chars: number): RequestCompositionPart => ({
    kind: "system_section",
    id,
    label,
    chars,
    estTokens: estimateTokens(chars),
    fidelity: "exact",
  });
  const hookSkillsChars = hookParts
    .filter((part) => part.kind === "skills_listing")
    .reduce((sum, part) => sum + part.chars, 0);
  const harnessSystemChars = Math.max(0, harness.systemChars - hookSkillsChars);

  if (!worker) {
    return [exactPart("harness:system", "system prompt as sent", harnessSystemChars), ...hookParts];
  }
  const carried = worker.parts.filter(
    (part) =>
      part.kind !== "tool_schemas" && !(part.kind === "skills_listing" && hookSkillsChars > 0),
  );
  const ours = carried
    .filter((part) => SYSTEM_PROMPT_KINDS.has(part.kind))
    .reduce((sum, part) => sum + part.chars, 0);
  const baseChars = harnessSystemChars - ours;
  const messageExtraChars =
    harness.firstMessageChars === undefined
      ? 0
      : harness.firstMessageChars -
        carried
          .filter((part) => part.kind === "task_prompt" || part.kind === "memories")
          .reduce((sum, part) => sum + part.chars, 0);
  return [
    ...carried,
    ...(baseChars > 0 ? [exactPart("harness:base", "harness base prompt", baseChars)] : []),
    ...(messageExtraChars > 0
      ? [exactPart("harness:messages", "harness context in the first message", messageExtraChars)]
      : []),
    ...hookParts,
  ];
}

/** Observed tokens per `chars / 4`, or null when the call gives nothing to learn from. */
export function observedTokenRatio(promptTokens: number, payloadChars: number): number | null {
  if (!(promptTokens > 0) || !(payloadChars > 0)) return null;
  return promptTokens / (payloadChars / 4);
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

    const { body } = parsed;
    let parts: RequestCompositionPart[] = body.parts.map((part) => ({
      ...part,
      estTokens: estimateTokens(part.chars),
    }));
    let tokenRatio: number;
    if (body.source === "harness-hook") {
      if (!body.harness) {
        jsonError(res, "harness-hook manifests require `harness` totals", 400);
        return true;
      }
      parts = mergeHookParts(parts, body.harness, await getLatestWorkerComposition(body.sessionId));
      // This manifest keeps its own call's ratio, so its residual is ~0. The
      // provider average serves the sessions that follow.
      const observed = observedTokenRatio(body.harness.promptTokens, body.harness.payloadChars);
      if (observed === null) {
        tokenRatio = await getTokenRatio(body.provider);
      } else {
        tokenRatio = clampTokenRatio(observed);
        await recordTokenRatio(body.provider, observed);
      }
    } else {
      const toolPart = await toolSchemaPart(myAgentId, task, body.toolLoading);
      if (toolPart) parts.push(toolPart);
      tokenRatio = await getTokenRatio(body.provider);
    }

    const manifest = await createRequestComposition({
      taskId: task.id,
      agentId: myAgentId,
      sessionId: body.sessionId,
      provider: body.provider,
      model: body.model,
      source: body.source,
      parts,
      tokenRatio,
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
