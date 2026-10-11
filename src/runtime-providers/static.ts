import type { ConfigStatus, RuntimeHandle, RuntimeProvider, RuntimeStatus } from "./types";

export class StaticRuntimeProvider implements RuntimeProvider {
  readonly kind = "static" as const;
  readonly traits = { canProvision: false, ephemeralDisk: false, supportsPause: false };

  checkConfig(): ConfigStatus {
    return { ready: true, missing: [] };
  }

  async provision(): Promise<RuntimeHandle> {
    throw new Error("static pools are operator-managed");
  }

  async terminate(): Promise<void> {
    throw new Error("static pools are operator-managed");
  }

  async status(): Promise<RuntimeStatus> {
    return "unknown";
  }

  async list(): Promise<RuntimeHandle[]> {
    return [];
  }
}
