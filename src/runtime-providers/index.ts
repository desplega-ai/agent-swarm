import type { RuntimeProvider, RuntimeProviderKind } from "./types";

export type * from "./types";

/**
 * Lazy factory, same pattern as `createProviderAdapter` in src/providers/index.ts:
 * adapters are imported on demand so unused provider SDKs never load.
 */
export async function createRuntimeProvider(kind: RuntimeProviderKind): Promise<RuntimeProvider> {
  switch (kind) {
    case "docker": {
      const { DockerRuntimeProvider } = await import("./docker");
      return new DockerRuntimeProvider();
    }
    case "e2b": {
      const { E2BRuntimeProvider } = await import("./e2b");
      return new E2BRuntimeProvider();
    }
    default:
      throw new Error(`Unknown runtime provider: "${kind}". Supported in spike: docker, e2b`);
  }
}
