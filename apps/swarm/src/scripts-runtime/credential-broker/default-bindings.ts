import type { CredentialBinding } from "./types";

/**
 * Backward-compatible seed for the original PR #708 behavior.
 *
 * It is intentionally modeled as a binding, not as fetch-patcher special-case
 * logic: operators can add more bindings through swarm_config without editing
 * the runtime code.
 */
export const DEFAULT_CREDENTIAL_BINDINGS: CredentialBinding[] = [
  {
    configKey: "GITHUB_TOKEN",
    allowedHosts: ["api.github.com"],
    headerTemplate: "Authorization: Bearer [REDACTED:GITHUB_TOKEN]",
    scope: "global",
    scopeId: null,
    active: true,
  },
];
