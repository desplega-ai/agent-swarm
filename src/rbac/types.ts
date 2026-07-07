/**
 * RBAC core types (DES-445, slice 1).
 *
 * Pure type definitions — no runtime imports beyond the permission registry.
 * `can()` is pure: callers pass the rows they already fetched (agent, task,
 * resource metadata); the engine never touches the DB.
 */
import type { PermissionVerb } from "./permissions";

export type RbacPrincipal =
  | { kind: "agent"; agentId: string; isLead: boolean }
  | { kind: "user"; userId: string }
  /** Shared swarm key (operator bearer). */
  | { kind: "operator" };

/**
 * Only what the legacy rules need — richer resource shapes arrive with
 * resource ACLs (increment 6).
 */
export type RbacResource =
  | {
      kind: "task";
      taskId: string;
      requestedByUserId?: string | null;
      creatorAgentId?: string | null;
      /** Assignee. fs "owner" = assignee OR creator (src/http/fs.ts canMutateTask). */
      agentId?: string | null;
    }
  /** Target-agent resources (profile, context, skills-for-agent). */
  | { kind: "agent"; agentId: string }
  | { kind: "kv-namespace"; namespace: string }
  /** Skills, mcp-servers, memory entries, scripts. */
  | { kind: "owned"; ownerAgentId?: string | null; scope?: string }
  | { kind: "none" };

export type RbacDecision =
  | { allow: true }
  | { allow: false; reason: string; missing: PermissionVerb };

export type RbacCheck = {
  principal: RbacPrincipal;
  verb: PermissionVerb;
  resource?: RbacResource;
  source: "mcp" | "http";
};
