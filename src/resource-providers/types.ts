import type { Resource } from "../types";

export type ResourceIdentity = { ownerId: string; resourceId: string; generation: number };
/** API-private value. Public resource responses never include this handle. */
export type ResourceHandle = ResourceIdentity & { externalId: string };
export type ProviderState = "running" | "paused" | "stopped" | "destroyed" | "unknown";
export type ProviderTraits = {
  supportsPause: boolean;
  maxContinuousMs: number;
  previewAccess: "public" | "none";
  preservesTabsOnStop: false;
};
export class ResourceProviderError extends Error {
  constructor(
    public readonly code: "unsupported" | "not-found" | "conflict",
    message: string,
  ) {
    super(message);
    this.name = "ResourceProviderError";
  }
}
export type ProviderCreate = ResourceIdentity & {
  timeoutMs: number;
  config: Record<string, unknown>;
};
interface BaseProvider {
  readonly provider: Resource["provider"];
  readonly traits: ProviderTraits;
  status(handle: ResourceHandle): Promise<ProviderState>;
  pause(handle: ResourceHandle): Promise<void>;
  resume(handle: ResourceHandle, timeoutMs: number): Promise<ResourceHandle>;
  destroy(handle: ResourceHandle): Promise<void>;
  listOwned(ownerId: string): Promise<ResourceHandle[]>;
}
export interface SandboxProvider extends BaseProvider {
  readonly kind: "sandbox";
  create(input: ProviderCreate): Promise<ResourceHandle>;
  exec(
    handle: ResourceHandle,
    input: { command: string; timeoutMs: number; cwd?: string },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  writeFiles(handle: ResourceHandle, files: { path: string; data: Uint8Array }[]): Promise<void>;
  readFile(handle: ResourceHandle, path: string): Promise<Uint8Array>;
  previewUrl(handle: ResourceHandle, port: number): Promise<string>;
}
export interface BrowserProvider extends BaseProvider {
  readonly kind: "browser";
  create(input: ProviderCreate & { profileHandle?: string }): Promise<ResourceHandle>;
  stop(handle: ResourceHandle): Promise<void>;
  createProfile(name: string): Promise<string>;
  listProfiles(): Promise<{ externalId: string; name: string }[]>;
  deleteProfile(externalId: string): Promise<void>;
  connection(
    handle: ResourceHandle,
  ): Promise<{ cdpUrl: string; liveUrl: string; expiresAt: string }>;
}
export type ResourceProvider = SandboxProvider | BrowserProvider;
export type ResourceProviderSelection =
  | { kind: "sandbox"; provider: "e2b" | "fake" }
  | { kind: "browser"; provider: "browser-use" | "fake" };
