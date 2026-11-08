export type ResourceRate = { dimension: string; usdPerMs: number; effectiveAt: string };

import type { Resource } from "../types";

export type ResourceIdentity = { ownerId: string; resourceId: string; generation: number };
/** API-private value. Public resource responses never include this handle. */
export type ResourceHandle = ResourceIdentity & { externalId: string };
export type ProviderState = "running" | "paused" | "stopped" | "destroyed" | "unknown";
export type ProviderTraits = {
  supportsPause: boolean;
  leaseRenewal: "extendable" | "fixed";
  maxContinuousMs: number;
  previewAccess: "public" | "none";
  preservesTabsOnStop: false;
};
export class ResourceProviderError extends Error {
  constructor(
    public readonly code: "unsupported" | "not-found" | "conflict" | "capacity" | "deadline",
    message: string,
  ) {
    super(message);
    this.name = "ResourceProviderError";
  }
}
/** Mutations must honor cancellation and the absolute session deadline, even after transport delays. */
export type ProviderOperationContext = {
  signal: AbortSignal;
  deadlineAt: string;
  sessionDeadlineAt?: string;
};
export type ProviderCreate = ResourceIdentity & {
  timeoutMs: number;
  config: Record<string, unknown>;
};
interface BaseProvider {
  readonly provider: Resource["provider"];
  readonly traits: ProviderTraits;
  readonly rates: readonly ResourceRate[];
  /** Renew a running session without resuming a stopped session. */
  renewLease(
    handle: ResourceHandle,
    timeoutMs: number,
    context?: ProviderOperationContext,
  ): Promise<ResourceHandle>;
  status(handle: ResourceHandle, context?: ProviderOperationContext): Promise<ProviderState>;
  pause(handle: ResourceHandle, context?: ProviderOperationContext): Promise<void>;
  resume(
    handle: ResourceHandle,
    timeoutMs: number,
    context?: ProviderOperationContext,
  ): Promise<ResourceHandle>;
  destroy(handle: ResourceHandle, context?: ProviderOperationContext): Promise<void>;
  /** Return a complete, authoritative ownership listing. Throw on errors or incomplete pages. */
  listOwned(ownerId: string, context?: ProviderOperationContext): Promise<ResourceHandle[]>;
}
export interface SandboxProvider extends BaseProvider {
  readonly kind: "sandbox";
  create(input: ProviderCreate, context?: ProviderOperationContext): Promise<ResourceHandle>;
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
  create(
    input: ProviderCreate & { profileHandle?: string },
    context?: ProviderOperationContext,
  ): Promise<ResourceHandle>;
  stop(handle: ResourceHandle, context?: ProviderOperationContext): Promise<void>;
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
