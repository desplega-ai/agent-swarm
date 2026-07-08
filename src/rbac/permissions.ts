/**
 * Permission verb registry (DES-445, slice 1).
 *
 * One verb per hard authorization gate (plan Appendix A — 36 HARD sites at
 * HEAD 2026-07-07, incl. the two post-pin PR #918 slack gates, plus the
 * documented-but-unenforced scripts.ts global write/delete gap and the three
 * assertOwnsTask ownership verbs).
 *
 * Naming convention (brainstorm decision): `.own` = scoped to the caller's
 * own resources, `.any` = crosses ownership boundaries (today: lead-gated).
 * Descriptions become an API contract in increment 3 — keep them precise.
 *
 * Scope boundary: the kv `task:page:*` header guard (src/http/kv.ts) is a
 * request-shape structural check, NOT a principal permission — it has no verb
 * and stays inline at its call sites.
 */
import * as z from "zod";

export const PERMISSIONS = {
  "user.manage": {
    description: "Create, update, or deactivate user profiles.",
    namespace: "user",
  },
  "agent.profile.update.any": {
    description: "Update another agent's profile.",
    namespace: "agent",
  },
  "agent.context.read.any": {
    description: "View or diff another agent's context history.",
    namespace: "agent",
  },
  "task.cancel.any": {
    description: "Cancel any task (beyond tasks the caller created).",
    namespace: "task",
  },
  "task.read.own": {
    description: "Read details of a task the principal requested.",
    namespace: "task",
  },
  "task.cancel.own": {
    description: "Cancel a task the principal requested.",
    namespace: "task",
  },
  "task.action.own": {
    description: "Run actions (follow-up, retry, ...) on a task the principal requested.",
    namespace: "task",
  },
  "task.fs.mutate": {
    description: "Mutate a task's filesystem artifacts and attachments.",
    namespace: "task",
  },
  "memory.learning.inject": {
    description: "Inject a learning into another agent's memory.",
    namespace: "memory",
  },
  "memory.delete.any": {
    description: "Delete a memory entry (own entries, or swarm-scoped entries as lead).",
    namespace: "memory",
  },
  "channel.delete": {
    description: "Delete a Slack channel.",
    namespace: "channel",
  },
  "integration.kapso.manage": {
    description: "Register or unregister a Kapso inbound number.",
    namespace: "integration",
  },
  "integration.slack.post": {
    description: "Post to a direct Slack channel.",
    namespace: "integration",
  },
  "integration.slack.read": {
    description: "Read a direct Slack channel.",
    namespace: "integration",
  },
  "integration.slack.thread.start": {
    description: "Start a thread in a direct Slack channel.",
    namespace: "integration",
  },
  "integration.slack.upload": {
    description: "Upload a file to a direct Slack channel.",
    namespace: "integration",
  },
  "integration.slack.delete": {
    description: "Delete a Slack message.",
    namespace: "integration",
  },
  "integration.slack.update": {
    description: "Update (edit) a Slack message.",
    namespace: "integration",
  },
  "credential-binding.manage": {
    description: "Manage script credential bindings.",
    namespace: "credential-binding",
  },
  "script-connection.manage": {
    description: "Manage script connections.",
    namespace: "script-connection",
  },
  "config.credential-bindings.write": {
    description: "Write the SCRIPT_CREDENTIAL_BINDINGS swarm-config key.",
    namespace: "config",
  },
  "config.write.any": {
    description: "Write any swarm-config key.",
    namespace: "config",
  },
  "config.delete.any": {
    description: "Delete any swarm-config entry.",
    namespace: "config",
  },
  "config.read.secrets": {
    description: "Read unmasked secret config values.",
    namespace: "config",
  },
  "skill.create.swarm": {
    description: "Create a swarm-scoped skill.",
    namespace: "skill",
  },
  "skill.install.any": {
    description: "Install a skill for another agent.",
    namespace: "skill",
  },
  "skill.install.global": {
    description: "Install a remote/global skill.",
    namespace: "skill",
  },
  "skill.uninstall.any": {
    description: "Uninstall a skill for another agent.",
    namespace: "skill",
  },
  "skill.update.any": {
    description: "Update a skill the caller does not own.",
    namespace: "skill",
  },
  "skill.promote.swarm": {
    description: "Promote a skill to swarm scope (skill-approval path).",
    namespace: "skill",
  },
  "skill.delete.any": {
    description: "Delete a skill the caller does not own.",
    namespace: "skill",
  },
  "mcp-server.create.swarm": {
    description: "Create a swarm- or global-scoped MCP server.",
    namespace: "mcp-server",
  },
  "mcp-server.install.any": {
    description: "Install an MCP server for another agent.",
    namespace: "mcp-server",
  },
  "mcp-server.uninstall.any": {
    description: "Uninstall an MCP server for another agent.",
    namespace: "mcp-server",
  },
  "mcp-server.delete.any": {
    description: "Delete an MCP server the caller does not own.",
    namespace: "mcp-server",
  },
  "mcp-server.update.any": {
    description: "Update an MCP server the caller does not own.",
    namespace: "mcp-server",
  },
  "mcp-oauth.authorize.any": {
    description: "Start an MCP-server OAuth authorize flow for a caller-supplied user scope.",
    namespace: "mcp-oauth",
  },
  "kv.write.any": {
    description: "Write another agent's task:agent: KV namespace.",
    namespace: "kv",
  },
  "script.global.write": {
    description: "Create or update a global-scope script.",
    namespace: "script",
  },
  "script.global.delete": {
    description: "Delete a global-scope script.",
    namespace: "script",
  },
} as const satisfies Record<string, { description: string; namespace: string }>;

export type PermissionVerb = keyof typeof PERMISSIONS;

export const PERMISSION_VERBS = Object.keys(PERMISSIONS) as [PermissionVerb, ...PermissionVerb[]];

export const PermissionVerbSchema = z.enum(PERMISSION_VERBS);
