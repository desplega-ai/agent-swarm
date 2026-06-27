import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { AgentTask, User } from "@swarm/types";
import type { RequestInfo } from "./utils";

export type ToolCtx =
  | { kind: "owner"; agentId?: string; sourceTaskId?: string; sessionId?: string }
  | { kind: "user"; userId: string; user: User; sessionId?: string };

export function ownerCtx(info: RequestInfo): ToolCtx {
  return {
    kind: "owner",
    agentId: info.agentId,
    sourceTaskId: info.sourceTaskId,
    sessionId: info.sessionId,
  };
}

export function userCtx(user: User, sessionId?: string): ToolCtx {
  return {
    kind: "user",
    userId: user.id,
    user,
    sessionId,
  };
}

export function assertOwnsTask(ctx: ToolCtx, task: AgentTask): CallToolResult | null {
  if (ctx.kind === "owner" || task.requestedByUserId === ctx.userId) {
    return null;
  }

  const message = `Forbidden: this task is not yours (task ${task.id}).`;
  // RBAC chokepoint — a future admin/role tier widens visibility here, in this one function.
  return {
    isError: true,
    content: [{ type: "text", text: message }],
    structuredContent: {
      success: false,
      code: "forbidden",
      message,
    },
  };
}
