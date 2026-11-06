import { resolveGitHubHost } from "../../utils/github-host";
import type { CredentialBinding } from "./types";

/**
 * Backward-compatible seed for the original PR #708 behavior.
 *
 * It is intentionally modeled as a binding, not as fetch-patcher special-case
 * logic: operators can add more bindings through swarm_config without editing
 * the runtime code.
 */
export const defaultCredentialBindings = (): CredentialBinding[] => {
  const host = resolveGitHubHost();
  // Fail closed: an invalid GITHUB_URL / GITHUB_API_URL binds GITHUB_TOKEN to no host
  // (never api.github.com), and script runs carry on without it.
  if (!host.ok) return [];
  return [
    {
      configKey: "GITHUB_TOKEN",
      // The configured GitHub API host only: on GHES the PAT never goes to api.github.com.
      allowedHosts: [host.config.apiHost],
      headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
      scope: "global",
      scopeId: null,
      active: true,
      authKind: "config",
    },
  ];
};
