// @swarm/integrations barrel — hand-maintained since Phase 5 extraction.
// Sources live under ./src/. `export * as Ns` re-exports resolve name collisions
// (e.g. gitlab vs github share IssueEvent/handleIssue/etc.). gitlab's colliding
// handlers+types are reachable via the "@swarm/integrations/gitlab" subpath
// (the physical ./gitlab.ts re-export file + tsconfig path). Symbols unique to a
// namespaced module are re-exposed flat below.
// NOTE: this package intentionally declares NO package.json "exports" field so
// tests can deep-import `@swarm/integrations/src/<dir>/templates?t=<n>` to force
// side-effect template re-registration (same pattern as @swarm/prompt-templates).

// Collision-safe flat re-export: keepalive is namespaced (OauthKeepalive) only
// because it shares a `_test` export with other modules; these two are unique.
export { startOAuthKeepalive, stopOAuthKeepalive } from "./src/oauth/keepalive";
// oauth/wrapper is namespaced (OauthWrapper) because its public symbols collide
// with oauth/index's re-exports; these test-internal helpers live only here.
export { _clearPendingStates, _getPendingState } from "./src/oauth/wrapper";

export * from "./src/agentmail/app";
export * from "./src/agentmail/handlers";
export * as AgentmailIndex from "./src/agentmail/index";
export * from "./src/agentmail/templates";
export * from "./src/agentmail/types";
export * from "./src/github/app";
export * from "./src/github/handlers";
export * as GithubIndex from "./src/github/index";
export * from "./src/github/mentions";
export * from "./src/github/reactions";
export * from "./src/github/task-reactions";
export * from "./src/github/templates";
export * from "./src/github/types";
export * from "./src/gitlab/auth";
export * as GitlabHandlers from "./src/gitlab/handlers";
export * as GitlabIndex from "./src/gitlab/index";
export * from "./src/gitlab/reactions";
export * from "./src/gitlab/templates";
export * as GitlabTypes from "./src/gitlab/types";
export * from "./src/integrations/kapso/client";
export * from "./src/integrations/kapso/config";
export * from "./src/integrations/kapso/inbound";
export * from "./src/jira/adf";
export * from "./src/jira/app";
export * from "./src/jira/client";
export * as JiraIndex from "./src/jira/index";
export * from "./src/jira/metadata";
export * from "./src/jira/oauth";
export * from "./src/jira/outbound";
export * from "./src/jira/sync";
export * from "./src/jira/templates";
export * from "./src/jira/types";
export * from "./src/jira/webhook-lifecycle";
export * from "./src/jira/webhook";
export * from "./src/linear/app";
export * from "./src/linear/client";
export * from "./src/linear/gate";
export * as LinearIndex from "./src/linear/index";
export * from "./src/linear/oauth";
export * from "./src/linear/outbound";
export * from "./src/linear/sync";
export * from "./src/linear/templates";
export * from "./src/linear/types";
export * from "./src/linear/webhook";
export * from "./src/oauth/ensure-mcp-token";
export * from "./src/oauth/ensure-token";
export * from "./src/oauth/index";
export * as OauthKeepalive from "./src/oauth/keepalive";
export * from "./src/oauth/mcp-wrapper";
export * as OauthWrapper from "./src/oauth/wrapper";
export * from "./src/slack/actions";
export * from "./src/slack/app";
export * from "./src/slack/assistant";
export * from "./src/slack/blocks";
export * from "./src/slack/channel-activity";
export * from "./src/slack/channel-join";
export * from "./src/slack/commands";
export * from "./src/slack/enrich";
export * from "./src/slack/event-dedup";
export * from "./src/slack/files";
export * from "./src/slack/handlers";
export * as SlackIndex from "./src/slack/index";
export * from "./src/slack/message-text";
export * as SlackResponses from "./src/slack/responses";
export * from "./src/slack/router";
export * from "./src/slack/templates";
export * from "./src/slack/thread-buffer";
export * from "./src/slack/types";
export * from "./src/slack/watcher";
export * from "./src/x/composio";
// NOTE: ./src/x402/cli is a zero-export, run-by-path CLI entrypoint (shebang,
// prints/executes at module scope). It is intentionally NOT re-exported here —
// eager barrel evaluation would run the CLI on import. (Same class as the dropped
// scripts subprocess entrypoints.)
export * from "./src/x402/client";
export * from "./src/x402/config";
export * as X402Index from "./src/x402/index";
export * from "./src/x402/openfort-signer";
export * from "./src/x402/spending-tracker";
