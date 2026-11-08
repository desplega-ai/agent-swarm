import type { ResourceHandle } from "../../resource-providers/types";
import { registerStoredSecret } from "../secret-registry";

type SecretValue = string | SecretValue[] | { [key: string]: SecretValue };

/**
 * Both fields are encrypted. Only explicit secret leaves enter the scrubber registry.
 * Snapshot values are non-secret replay data, such as repository URLs and setup commands.
 * Callers must separate credentials from the snapshot without guessing from property names.
 */
export type ResourcePrivateConfig = {
  snapshot: Record<string, unknown>;
  secrets?: Record<string, SecretValue>;
};

/** Public identity stays intact. External IDs and connection credentials are provider-private. */
export type ResourcePrivateHandle = ResourceHandle & {
  connection?: { cdpUrl?: string; liveUrl?: string };
};

function registerSecretLeaves(value: SecretValue, name: string): void {
  if (typeof value === "string") registerStoredSecret(value, name);
  else for (const entry of Object.values(value)) registerSecretLeaves(entry, name);
}

export function registerResourceConfig(config: ResourcePrivateConfig, name: string): void {
  if (config.secrets) registerSecretLeaves(config.secrets, name);
}

export function registerResourceHandle(handle: ResourcePrivateHandle, name: string): void {
  registerStoredSecret(handle.externalId, name);
  if (handle.connection?.cdpUrl) registerStoredSecret(handle.connection.cdpUrl, name);
  if (handle.connection?.liveUrl) registerStoredSecret(handle.connection.liveUrl, name);
}
