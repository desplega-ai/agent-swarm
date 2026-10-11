import { scrubSecrets } from "../utils/secret-scrubber";
import type {
  ProvisionRequest,
  RuntimeHandle,
  RuntimeProvider,
  RuntimeProviderTraits,
  RuntimeStatus,
  RuntimeTargetConfig,
} from "./types";

export class ControllerOfflineError extends Error {
  constructor(
    readonly controllerId: string,
    message = `Runtime controller ${controllerId} is offline`,
  ) {
    super(message);
    this.name = "ControllerOfflineError";
  }
}

export interface ControllerCommands {
  readonly traits: RuntimeProviderTraits;
  readonly workerApiUrl?: string;
  provision(req: ProvisionRequest): Promise<RuntimeHandle>;
  terminate(handle: RuntimeHandle, reason: string): Promise<void>;
  status(handles: RuntimeHandle[]): Promise<Record<string, RuntimeStatus>>;
  list(ownerId: string): Promise<RuntimeHandle[]>;
  renew?(handle: RuntimeHandle, ttlSec: number): Promise<{ endAt: string }>;
  pause?(handle: RuntimeHandle): Promise<void>;
  resume?(handle: RuntimeHandle): Promise<void>;
}

export class BuiltinController implements ControllerCommands {
  readonly traits: RuntimeProviderTraits;
  readonly workerApiUrl?: string;
  readonly renew?: ControllerCommands["renew"];
  readonly pause?: ControllerCommands["pause"];
  readonly resume?: ControllerCommands["resume"];

  constructor(
    readonly id: string,
    private readonly provider: RuntimeProvider,
    private readonly target: RuntimeTargetConfig,
    workerApiUrl?: string,
  ) {
    this.traits = provider.traits;
    this.workerApiUrl = workerApiUrl;
    if (provider.renew)
      this.renew = (handle, ttlSec) => this.call(() => provider.renew!(target, handle, ttlSec));
    if (provider.pause) this.pause = (handle) => this.call(() => provider.pause!(target, handle));
    if (provider.resume)
      this.resume = (handle) => this.call(() => provider.resume!(target, handle));
  }

  private async call<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      throw new Error(scrubSecrets(String(error)));
    }
  }

  async provision(req: ProvisionRequest): Promise<RuntimeHandle> {
    const handle = await this.call(() => this.provider.provision(this.target, req));
    return { ...handle, controllerId: this.id };
  }

  async terminate(handle: RuntimeHandle, reason: string): Promise<void> {
    await this.call(() => this.provider.terminate(this.target, handle, reason));
  }

  async status(handles: RuntimeHandle[]): Promise<Record<string, RuntimeStatus>> {
    const entries = await Promise.all(
      handles.map(async (handle) => [
        handle.externalId,
        await this.call(() => this.provider.status(this.target, handle)),
      ]),
    );
    return Object.fromEntries(entries);
  }

  async list(ownerId: string): Promise<RuntimeHandle[]> {
    const handles = await this.call(() => this.provider.list(this.target, ownerId));
    return handles.map((handle) => ({ ...handle, controllerId: this.id }));
  }
}
