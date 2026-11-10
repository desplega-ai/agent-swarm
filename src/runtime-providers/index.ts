import type { RuntimeProvider, RuntimeProviderKind, RuntimeTargetConfig } from "./types";

export type * from "./types";

export function canProvisionKind(kind: RuntimeProviderKind): boolean {
  return kind === "docker" || kind === "e2b" || kind === "boxd" || kind === "k8s";
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
    case "boxd": {
      const { BoxdRuntimeProvider } = await import("./boxd");
      return new BoxdRuntimeProvider();
    }
    case "k8s": {
      const { KubernetesRuntimeProvider } = await import("./k8s");
      return new KubernetesRuntimeProvider();
    }
    default:
      throw new Error(
        `Unknown runtime provider: "${kind}". Supported: static, docker, e2b, boxd, k8s`,
      );
  }
}
