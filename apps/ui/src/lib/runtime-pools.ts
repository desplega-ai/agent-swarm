import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import type {
  RuntimeController,
  RuntimeDeliveryMode,
  RuntimePool,
  RuntimePoolLifecycle,
  RuntimePoolRuntime,
  RuntimeProviderKind,
} from "@/api/types";
import { useStatusContext } from "@/app/status-context";

/**
 * First API release that serves the runtime pool routes. The release PR must
 * keep this equal to the shipped version.
 */
export const RUNTIME_POOLS_MIN_VERSION = "1.169.0";

/**
 * Every provider kind the API knows, in display order. The root test
 * `src/tests/runtime-provider-registration.test.ts` reads this literal, so a
 * new kind in `RuntimeProviderKindSchema` fails CI until it is listed here.
 */
export const RUNTIME_PROVIDER_KINDS: readonly RuntimeProviderKind[] = [
  "static",
  "docker",
  "e2b",
  "boxd",
  "k8s",
];

/** Kinds the API rejects on write. Shown disabled in pickers. */
export const COMING_SOON_KINDS: ReadonlySet<RuntimeProviderKind> = new Set(["k8s"]);

export const RUNTIME_KIND_LABEL: Record<RuntimeProviderKind, string> = {
  static: "Static",
  docker: "Docker",
  e2b: "E2B",
  boxd: "boxd",
  k8s: "Kubernetes",
};

export const RUNTIME_KIND_DESCRIPTION: Record<RuntimeProviderKind, string> = {
  static: "Operator-managed workers. The swarm never starts or stops them.",
  docker: "Containers on a Docker host.",
  e2b: "E2B cloud sandboxes.",
  boxd: "boxd microVMs that run the worker image.",
  k8s: "Coming soon.",
};

export const RUNTIME_LIFECYCLES: readonly RuntimePoolLifecycle[] = ["idle", "per-task"];

export const RUNTIME_LIFECYCLE_LABEL: Record<RuntimePoolLifecycle, string> = {
  idle: "Keep while idle",
  "per-task": "One per task",
};

export const RUNTIME_DELIVERY_LABEL: Record<RuntimeDeliveryMode | "default", string> = {
  default: "Swarm default",
  poll: "Poll",
  push: "Push",
};

export function deliveryLabel(delivery: RuntimeDeliveryMode | null): string {
  return RUNTIME_DELIVERY_LABEL[delivery ?? "default"];
}

/**
 * `StatusBadge` status per runtime state: a live runtime is "running", one the
 * controller is still starting is "starting".
 */
export const RUNTIME_STATUS_BADGE = {
  active: "running",
  provisioning: "starting",
  offline: "offline",
} as const satisfies Record<RuntimePoolRuntime["status"], string>;

/**
 * `StatusBadge` status per controller state. `unknown` has no `StatusBadge`
 * equivalent, so it maps to `null` and renders a neutral tag.
 */
export const CONTROLLER_STATUS_BADGE = {
  online: "healthy",
  offline: "offline",
  unknown: null,
} as const satisfies Record<RuntimeController["status"], string | null>;

/** The circuit breaker is open while `circuitOpenUntil` is in the future. */
export function isCircuitOpen(pool: Pick<RuntimePool, "circuitOpenUntil">): boolean {
  return pool.circuitOpenUntil !== null && new Date(pool.circuitOpenUntil).getTime() > Date.now();
}

/** Provider-side id from a runtime's external handle, when the provider set one. */
export function runtimeExternalId(runtime: RuntimePoolRuntime): string | null {
  const id = runtime.externalHandle?.externalId;
  return typeof id === "string" && id.length > 0 ? id : null;
}

export interface RuntimePoolsGate {
  /** The API serves runtime pools and the operator enabled them. */
  open: boolean;
  /** The version or `/status` answer is still unknown. */
  loading: boolean;
}

/**
 * The pools surface shows only when the API is new enough (dev mode bypasses
 * the version check inside `useFeatureGate`) AND `/status` reports
 * `runtime_pools.enabled`.
 */
export function useRuntimePoolsGate(): RuntimePoolsGate {
  const gate = useFeatureGate(RUNTIME_POOLS_MIN_VERSION);
  const status = useStatusContext();
  const versionLoading = gate.currentVersion === null && !gate.isError;
  return {
    open: gate.supported && status.data?.runtime_pools?.enabled === true,
    loading: versionLoading || status.isLoading,
  };
}
