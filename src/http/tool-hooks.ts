import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import type { ToolCallEvent } from "../extensions/contract";
import { dispatchPost, dispatchPre } from "../extensions/dispatcher";
import type { RequestInfo } from "../tools/utils";
import { scrubObject } from "../utils/secret-scrubber";
import { route } from "./route-def";
import { jsonError } from "./utils";

const REDACTION_MARKER = "[REDACTED:";

const toolCallFields = {
  harness: z.string().min(1).max(64).describe("Worker harness, such as `claude` or `pi`."),
  tool: z.string().min(1).max(256).describe("Canonical tool name, such as `bash` or `edit`."),
  nativeTool: z.string().min(1).max(256).optional().describe("The harness's own tool name."),
  args: z.unknown().describe("Canonical tool arguments."),
  rawArgs: z.unknown().optional().describe("The harness's own argument shape."),
  toolCallId: z.string().max(256).optional(),
  parentToolCallId: z.string().max(256).optional(),
};

const toolHookBody = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("pre"), ...toolCallFields }),
  z.object({
    phase: z.literal("post"),
    ...toolCallFields,
    result: z.unknown(),
    isError: z.boolean().optional(),
    durationMs: z.number().nonnegative(),
  }),
]);

const toolHookDecision = z.discriminatedUnion("action", [
  z.object({ action: z.literal("continue") }),
  z.object({ action: z.literal("modify"), args: z.unknown() }),
  z.object({ action: z.literal("block"), reason: z.string() }),
]);

const toolHookRoute = route({
  method: "post",
  path: "/api/tool-hooks",
  pattern: ["api", "tool-hooks"],
  summary: "Run extension tool hooks for a harness-native tool call",
  description:
    "A worker shim reports a harness built-in tool call (bash, read, write, edit). `phase: pre` " +
    "runs `pre.tool.call` with `callOrigin: native` and returns the decision. `phase: post` runs " +
    "`post.tool.call` observe-only and returns 202 at once. Only extensions whose manifest " +
    '`toolSources` includes `"native"` receive these calls. The server runs the secret scrubber ' +
    "over the body before any handler sees it, so handlers read `[REDACTED:<name>]` in place of " +
    "a secret. A `modify` whose args still carry that marker is rejected and the call continues " +
    "unchanged. Shims must also scrub worker-side before sending.",
  tags: ["Extensions"],
  auth: { apiKey: true, agentId: true },
  body: toolHookBody,
  maxBodyBytes: 2 * 1024 * 1024,
  rbac: { ungated: "self-scoped: an agent reports its own harness tool calls" },
  responses: {
    200: { description: "Pre-call decision", schema: toolHookDecision },
    202: {
      description: "Post-call event accepted",
      schema: z.object({ accepted: z.literal(true) }),
    },
    400: { description: "Invalid body or missing X-Agent-ID header" },
  },
});

function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

export async function handleToolHooks(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (!toolHookRoute.match(req.method, pathSegments)) return false;
  if (!myAgentId) {
    jsonError(res, "Missing X-Agent-ID header", 400);
    return true;
  }
  const parsed = await toolHookRoute.parse(req, res, pathSegments, queryParams);
  if (!parsed) return true;

  // Scrub at entry: handlers, extension_runs rows and logs only ever see the scrubbed body.
  const body = scrubObject(parsed.body);
  const sourceTaskId = header(req, "x-source-task-id");
  const requestInfo: RequestInfo = {
    sessionId: undefined,
    agentId: myAgentId,
    runtimeInstanceId: header(req, "x-runtime-instance-id"),
    sourceTaskId,
    auditSourceTaskId: sourceTaskId ?? header(req, "x-audit-source-task-id"),
    contextKey: header(req, "x-context-key"),
    callOrigin: "native",
    harness: body.harness,
  };
  const event: ToolCallEvent = {
    tool: body.tool,
    args: body.args,
    requestInfo,
    nativeTool: body.nativeTool,
    rawArgs: body.rawArgs,
    toolCallId: body.toolCallId,
    parentToolCallId: body.parentToolCallId,
  };

  if (body.phase === "post") {
    toolHookRoute.respond(res, 202, { accepted: true });
    void dispatchPost("post.tool.call", {
      ...event,
      result: body.result,
      isError: body.isError,
      durationMs: body.durationMs,
    });
    return true;
  }

  const result = await dispatchPre("pre.tool.call", event, {
    // A marker in rewritten args is a placeholder, not the secret: executing it would break
    // the call, so the rewrite is refused (an extension_runs error row) and the call continues.
    validateModify: (data) =>
      JSON.stringify(data.args ?? null).includes(REDACTION_MARKER)
        ? {
            success: false,
            error: new Error(
              `Modified arguments for native tool "${body.tool}" contain a redaction marker`,
            ),
          }
        : { success: true, data },
  });
  if (result.action === "block") {
    toolHookRoute.respond(res, 200, { action: "block", reason: result.reason });
  } else if (result.action === "modify") {
    toolHookRoute.respond(res, 200, { action: "modify", args: result.data.args });
  } else {
    toolHookRoute.respond(res, 200, { action: "continue" });
  }
  return true;
}
