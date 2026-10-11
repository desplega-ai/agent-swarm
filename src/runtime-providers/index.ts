import type { RuntimeProvider, RuntimeProviderKind, RuntimeTargetConfig } from "./types";

export type * from "./types";

export function canProvisionKind(kind: RuntimeProviderKind): boolean {
  return kind === "docker" || kind === "e2b";
}

/**
 * Lazy factory, same pattern as `createProviderAdapter` in src/providers/index.ts:
 * adapters are imported on demand so unused provider SDKs never load.
 */
export async function createRuntimeProvider(
  kind: RuntimeProviderKind,
  target: RuntimeTargetConfig = {},
): Promise<RuntimeProvider> {
  switch (kind) {
    case "static": {
      const { StaticRuntimeProvider } = await import("./static");
      return new StaticRuntimeProvider();
    }
    case "docker": {
      const { DockerRuntimeProvider } = await import("./docker");
      return new DockerRuntimeProvider();
    }
    case "e2b": {
      const { E2BRuntimeProvider } = await import("./e2b");
      return new E2BRuntimeProvider(target);
    }
    case "k8s":
      throw new Error(
        'Unknown runtime provider: "k8s" (not implemented). Supported: static, docker, e2b',
      );
    default:
      throw new Error(`Unknown runtime provider: "${kind}". Supported: static, docker, e2b`);
  }
}
