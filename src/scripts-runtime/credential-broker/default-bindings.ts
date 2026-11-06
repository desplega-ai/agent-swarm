import { getGitHubHostConfig } from "../../utils/github-host";
import type { CredentialBinding } from "./types";

/**
 * Backward-compatible seed for the original PR #708 behavior.
 *
 * It is intentionally modeled as a binding, not as fetch-patcher special-case
 * logic: operators can add more bindings through swarm_config without editing
 * the runtime code.
 */
export const defaultCredentialBindings = (): CredentialBinding[] => [
  {
    configKey: "GITHUB_TOKEN",
    // The configured GitHub API host only: on GHES the PAT never goes to api.github.com.
    allowedHosts: [getGitHubHostConfig().apiHost],
    headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
    scope: "global",
    scopeId: null,
    active: true,
    authKind: "config",
  },
];
