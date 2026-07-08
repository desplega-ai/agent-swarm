/**
 * Built-in legacy policy (DES-445, slice 1).
 *
 * Data-driven rule table reproducing TODAY'S exact inline authorization rules
 * (research doc §3 / plan Appendix A, verified against HEAD 2026-07-07).
 * This IS `can()`'s disabled-mode policy — not allow-all. The role engine
 * (increment 3) replaces the lookup behind the same `can()` signature.
 *
 * Every rule is a small pure predicate `(principal, resource) => boolean`.
 * Compile-time exhaustiveness: `LEGACY_POLICY` must cover every
 * `PermissionVerb` (enforced via `satisfies`).
 */
import type { PermissionVerb } from "./permissions";
import type { RbacPrincipal, RbacResource } from "./types";

export type LegacyRule = {
  /** Stable rule identifier — surfaces in audit rows and debug output. */
  name: string;
  /** Human-readable reason attached to deny decisions. */
  denyReason: string;
  /** Pure predicate — true = allow. Never touches the DB. */
  evaluate: (principal: RbacPrincipal, resource: RbacResource | undefined) => boolean;
};

// ── Named rules (research §3 Rule column) ────────────────────────────────────

const leadOnly: LegacyRule = {
  name: "lead-only",
  denyReason: "requires lead agent",
  evaluate: (principal) => principal.kind === "agent" && principal.isLead,
};

const leadOrTaskCreator: LegacyRule = {
  name: "lead-or-task-creator",
  denyReason: "requires lead agent or task creator",
  evaluate: (principal, resource) => {
    if (principal.kind !== "agent") return false;
    if (principal.isLead) return true;
    return (
      resource?.kind === "task" &&
      resource.creatorAgentId != null &&
      resource.creatorAgentId === principal.agentId
    );
  },
};

const leadOrResourceOwner: LegacyRule = {
  name: "lead-or-resource-owner",
  denyReason: "requires lead agent or resource owner",
  evaluate: (principal, resource) => {
    if (principal.kind !== "agent") return false;
    if (principal.isLead) return true;
    return (
      resource?.kind === "owned" &&
      resource.ownerAgentId != null &&
      resource.ownerAgentId === principal.agentId
    );
  },
};

const leadOrOwnNamespace: LegacyRule = {
  name: "lead-or-own-namespace",
  denyReason: "requires lead agent or your own task:agent: namespace",
  evaluate: (principal, resource) => {
    if (principal.kind !== "agent") return false;
    if (principal.isLead) return true;
    // A blank agent id can never own a namespace — the pre-migration guards
    // used truthiness (`if (info.agentId && ...)`), so `X-Agent-ID: ""` plus
    // the literal namespace `task:agent:` must stay denied.
    return (
      principal.agentId !== "" &&
      resource?.kind === "kv-namespace" &&
      resource.namespace === `task:agent:${principal.agentId}`
    );
  },
};

const anyAuthenticated: LegacyRule = {
  name: "any-authenticated",
  denyReason: "requires an authenticated principal",
  // Reaching can() at all implies the request passed handleCore auth — every
  // constructed principal counts as authenticated. Unused by any slice-1 verb;
  // kept because Phase-1 additions and increment 3 need the rule kind.
  evaluate: () => true,
};

const requesterOwnsTask: LegacyRule = {
  name: "requester-owns-task",
  denyReason: "not the task requester",
  // Mirrors assertOwnsTask (src/tools/task-tool-ctx.ts): owner contexts
  // (agent-side and operator calls) always pass; user principals must match
  // the task's requestedByUserId.
  evaluate: (principal, resource) => {
    if (principal.kind !== "user") return true;
    return resource?.kind === "task" && resource.requestedByUserId === principal.userId;
  },
};

// ── Composites (verified against HEAD) ───────────────────────────────────────

/** memory.delete.any — owner OR (lead AND scope=swarm) (src/tools/memory-delete.ts:54-56). */
const memoryOwnerOrLeadSwarm: LegacyRule = {
  name: "memory-owner-or-lead-swarm",
  denyReason: "requires memory owner, or lead agent for swarm-scoped memories",
  evaluate: (principal, resource) => {
    if (principal.kind !== "agent" || resource?.kind !== "owned") return false;
    if (resource.ownerAgentId != null && resource.ownerAgentId === principal.agentId) return true;
    return principal.isLead && resource.scope === "swarm";
  },
};

/**
 * task.fs.mutate — operator OR user OR lead OR task-assignee OR task-creator
 * (src/http/fs.ts canMutateTask). Order-independent OR: today's early
 * operator/user returns short-circuit before agent identity, but no input
 * satisfies one branch while failing another, so a flat OR is equivalent
 * (plan Appendix A row 36 note).
 */
const taskFsMutate: LegacyRule = {
  name: "operator-or-user-or-lead-or-task-owner",
  denyReason: "requires operator, user, lead agent, task assignee, or task creator",
  evaluate: (principal, resource) => {
    if (principal.kind === "operator" || principal.kind === "user") return true;
    if (principal.isLead) return true;
    if (resource?.kind !== "task") return false;
    return (
      (resource.agentId != null && resource.agentId === principal.agentId) ||
      (resource.creatorAgentId != null && resource.creatorAgentId === principal.agentId)
    );
  },
};

/** All named (non-composite) rule kinds, keyed by identifier. */
export const LEGACY_RULES = {
  "lead-only": leadOnly,
  "lead-or-task-creator": leadOrTaskCreator,
  "lead-or-resource-owner": leadOrResourceOwner,
  "lead-or-own-namespace": leadOrOwnNamespace,
  "any-authenticated": anyAuthenticated,
  "requester-owns-task": requesterOwnsTask,
} as const;

// ── Verb → rule table ────────────────────────────────────────────────────────

export const LEGACY_POLICY = {
  "user.manage": leadOnly,
  "agent.profile.update.any": leadOnly,
  "agent.context.read.any": leadOnly,
  "task.cancel.any": leadOrTaskCreator,
  "task.read.own": requesterOwnsTask,
  "task.cancel.own": requesterOwnsTask,
  "task.action.own": requesterOwnsTask,
  "task.fs.mutate": taskFsMutate,
  "memory.learning.inject": leadOnly,
  "memory.delete.any": memoryOwnerOrLeadSwarm,
  "channel.delete": leadOnly,
  "integration.kapso.manage": leadOnly,
  "integration.slack.post": leadOnly,
  "integration.slack.read": leadOnly,
  "integration.slack.thread.start": leadOnly,
  "integration.slack.upload": leadOnly,
  "integration.slack.delete": leadOnly,
  "integration.slack.update": leadOnly,
  "credential-binding.manage": leadOnly,
  "script-connection.manage": leadOnly,
  "config.credential-bindings.write": leadOnly,
  "config.write.any": leadOnly,
  "config.delete.any": leadOnly,
  "config.read.secrets": leadOnly,
  "skill.create.swarm": leadOnly,
  "skill.install.any": leadOnly,
  "skill.install.global": leadOnly,
  "skill.uninstall.any": leadOnly,
  "skill.update.any": leadOrResourceOwner,
  "skill.promote.swarm": leadOnly,
  "skill.delete.any": leadOrResourceOwner,
  "mcp-server.create.swarm": leadOnly,
  "mcp-server.install.any": leadOnly,
  "mcp-server.uninstall.any": leadOnly,
  "mcp-server.delete.any": leadOrResourceOwner,
  "mcp-server.update.any": leadOrResourceOwner,
  "mcp-oauth.authorize.any": anyAuthenticated,
  "kv.write.any": leadOrOwnNamespace,
  "page.delete.any": leadOrResourceOwner,
  "script.global.write": leadOnly,
  "script.global.delete": leadOnly,
} as const satisfies Record<PermissionVerb, LegacyRule>;
