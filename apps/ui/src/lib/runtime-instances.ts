import type { RuntimeInstance } from "@/api/types";

export type RuntimeLiveness = "live" | "stale" | "offline";

export function runtimeLiveness(
  instance: Pick<RuntimeInstance, "status" | "isLive">,
): RuntimeLiveness {
  if (instance.isLive) return "live";
  return instance.status === "active" ? "stale" : "offline";
}

export const RUNTIME_LIVENESS_TONE: Record<
  RuntimeLiveness,
  { label: string; dot: string; badge: string }
> = {
  live: {
    label: "Live",
    dot: "bg-status-success",
    badge: "border-status-success/30 text-status-success-strong",
  },
  stale: {
    label: "Stale",
    dot: "bg-status-warning",
    badge: "border-status-warning/30 text-status-warning-strong",
  },
  offline: {
    label: "Offline",
    dot: "bg-status-neutral",
    badge: "border-status-neutral/30 text-status-neutral-strong",
  },
};

export function runtimeLivenessHelp(
  liveness: RuntimeLiveness,
  staleThresholdMinutes?: number,
): string {
  const window = staleThresholdMinutes ? `${staleThresholdMinutes}-minute ` : "";
  switch (liveness) {
    case "live":
      return `Reporting within the ${window}staleness window and eligible for new work.`;
    case "stale":
      return `No ping within the ${window}staleness window; not eligible for new work until it re-registers. In-flight work is not assumed dead.`;
    case "offline":
      return "The process closed; re-registration is the only way back to live.";
  }
}

export type RuntimeCredentialState = "ready" | "waiting" | "unreported";

export function runtimeCredentialState(
  credentialReady: boolean | null | undefined,
): RuntimeCredentialState {
  if (credentialReady === true) return "ready";
  if (credentialReady === false) return "waiting";
  return "unreported";
}

export const RUNTIME_CREDENTIAL_TONE: Record<
  RuntimeCredentialState,
  { label: string; badge: string; help: string }
> = {
  ready: {
    label: "Ready",
    badge: "border-status-success/30 text-status-success-strong",
    help: "This runtime reported its credentials as ready.",
  },
  waiting: {
    label: "Waiting",
    badge: "border-status-pending/30 text-status-pending-strong",
    help: "This runtime is waiting on credentials and cannot execute work until they arrive.",
  },
  unreported: {
    label: "Unreported",
    badge: "border-status-neutral/30 text-status-neutral-strong",
    help: "No credential report yet (e.g. CRED_CHECK_DISABLE) — treated as ready for dispatch.",
  },
};

export function formatSlots(count: number): string {
  return `${count} slot${count === 1 ? "" : "s"}`;
}

export function shortRuntimeId(id: string): string {
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}
