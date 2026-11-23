import type { SwarmConfig } from "../types";

/**
 * A global secret whose effective `exportToEnv` is false stays out of an agent's process env: the
 * agent reaches it only through a connection or a credential binding, never as a value. Every read
 * path that hands a plain agent config values (the HTTP config routes, a script run's userConfig)
 * masks such a row, so the flag decides what an agent can read, not only what its env holds.
 * A lead, the operator and a user are not affected, and neither is an agent's own agent-scope row.
 */
export function isHiddenFromAgentRead(
  config: Pick<SwarmConfig, "isSecret" | "scope" | "exportToEnv">,
): boolean {
  return config.isSecret && config.scope === "global" && config.exportToEnv === false;
}
