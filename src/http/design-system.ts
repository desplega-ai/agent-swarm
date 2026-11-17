import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { getDesignSystem, type StoredDesignSystem, saveDesignSystem } from "../be/design-system";
import { can } from "../rbac";
import { buildDesignSystem, DesignSystemError } from "../themes/design-system";
import { DesignSystemInputSchema, DesignSystemSchema } from "../types";
import { agentFirstPrincipal } from "./request-principal";
import { route } from "./route-def";
import { jsonError } from "./utils";

/**
 * The org design system over REST (src/themes/design-system.ts). The MCP
 * tools `design-system-get` / `design-system-set` share the same storage.
 */

const DesignSystemStateSchema = z.object({
  status: z.enum(["none", "invalid", "active", "declined"]),
  designSystem: DesignSystemSchema.nullable(),
  invalidReason: z.string().optional(),
  previous: DesignSystemSchema.nullable(),
});

const getDesignSystemRoute = route({
  method: "get",
  path: "/api/design-system",
  pattern: ["api", "design-system"],
  summary: "Get the org design system",
  tags: ["Pages"],
  responses: {
    200: {
      description: "The org design system and the value it replaced",
      schema: DesignSystemStateSchema,
    },
  },
});

const putDesignSystemRoute = route({
  method: "put",
  path: "/api/design-system",
  pattern: ["api", "design-system"],
  summary: "Set or decline the org design system",
  tags: ["Pages"],
  rbac: { permission: "design-system.write" },
  body: DesignSystemInputSchema,
  responses: {
    200: {
      description: "The saved, normalized design system",
      schema: z.object({ designSystem: DesignSystemSchema, ignoredTokens: z.array(z.string()) }),
    },
    400: { description: "Invalid design system" },
    403: { description: "Permission denied" },
  },
});

function recordOf(stored: StoredDesignSystem) {
  return "record" in stored ? stored.record : null;
}

export async function handleDesignSystem(
  req: IncomingMessage,
  res: ServerResponse,
  pathSegments: string[],
  queryParams: URLSearchParams,
  myAgentId: string | undefined,
): Promise<boolean> {
  if (getDesignSystemRoute.match(req.method, pathSegments)) {
    const parsed = await getDesignSystemRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const { current, previous } = await getDesignSystem();
    getDesignSystemRoute.respond(res, 200, {
      status: current.status,
      designSystem: recordOf(current),
      ...("reason" in current ? { invalidReason: current.reason } : {}),
      previous: recordOf(previous),
    });
    return true;
  }

  if (putDesignSystemRoute.match(req.method, pathSegments)) {
    const parsed = await putDesignSystemRoute.parse(req, res, pathSegments, queryParams);
    if (!parsed) return true;
    const principal = await agentFirstPrincipal(req, myAgentId);
    const decision = can({ principal, verb: "design-system.write", source: "http" });
    if (!decision.allow) {
      jsonError(res, decision.reason, 403);
      return true;
    }
    try {
      const { record, ignored } = buildDesignSystem(parsed.body, {
        userId: principal.kind === "user" ? principal.userId : null,
        ...(principal.kind === "agent" ? { agentId: principal.agentId } : {}),
      });
      await saveDesignSystem(record);
      putDesignSystemRoute.respond(res, 200, { designSystem: record, ignoredTokens: ignored });
    } catch (err) {
      if (!(err instanceof DesignSystemError)) throw err;
      jsonError(res, err.message, 400);
    }
    return true;
  }

  return false;
}
