import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { can, type PermissionVerb } from "@/rbac";
import type { AgentTask, User } from "@/types";
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

export function assertOwnsTask(
  ctx: ToolCtx,
  task: AgentTask,
  verb: PermissionVerb = "task.read.own",
): CallToolResult | null {
  // RBAC chokepoint — a future admin/role tier widens visibility here, in this one function.
  const decision = can({
    principal:
      ctx.kind === "owner"
        ? ctx.agentId
          ? { kind: "agent", agentId: ctx.agentId, isLead: false }
          : { kind: "operator" }
        : { kind: "user", userId: ctx.userId },
    verb,
    resource: { kind: "task", taskId: task.id, requestedByUserId: task.requestedByUserId },
    source: "mcp",
  });
  if (decision.allow) {
    return null;
  }

  const message = `Forbidden: this task is not yours (task ${task.id}).`;
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
