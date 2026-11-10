import type { RuntimePool, RuntimePoolWorkspace, RuntimeProviderKind } from "@/api/types";

/**
 * Kinds whose provider sets `traits.persistentWorkspace`. The API does not
 * serve provider traits, so the root test
 * `src/tests/runtime-provider-registration.test.ts` checks this list against them.
 */
export const RUNTIME_WORKSPACE_KINDS: readonly RuntimeProviderKind[] = ["docker", "k8s"];

/** Only Kubernetes sizes a workspace. Docker's `local` volume driver has no quota. */
export function workspaceHasSize(kind: RuntimeProviderKind): boolean {
  return kind === "k8s";
}

/** The Kubernetes provider's claim size when the pool sets none. */
export const WORKSPACE_DEFAULT_SIZE_GB = 20;

export interface WorkspaceForm {
  workspace: boolean;
  workspaceSizeGb: string;
  /** The operator changed the control since the form loaded. */
  workspaceTouched: boolean;
}

export function workspaceFormFromPool(pool: Pick<RuntimePool, "workspace"> | null): WorkspaceForm {
  const sizeGb = pool?.workspace?.sizeGb;
  return {
    workspace: Boolean(pool?.workspace),
    workspaceSizeGb: sizeGb === undefined ? "" : String(sizeGb),
    workspaceTouched: false,
  };
}

/**
 * The `workspace` part of a pool create or update body. An untouched form
 * yields no key: the API keeps the stored value on update and defaults to off
 * on create, and an API without the field (its schemas are strict) still
 * accepts the save.
 */
export function workspaceInput(
  kind: RuntimeProviderKind,
  form: WorkspaceForm,
): { error?: string; input: { workspace?: RuntimePoolWorkspace | null } } {
  const on = form.workspace && RUNTIME_WORKSPACE_KINDS.includes(kind);
  const size = on && workspaceHasSize(kind) ? form.workspaceSizeGb.trim() : "";
  if (size && !(/^\d+$/.test(size) && Number(size) >= 1 && Number(size) <= 1024))
    return { error: "Enter a whole number from 1 to 1024, or leave blank.", input: {} };
  if (!form.workspaceTouched) return { input: {} };
  return { input: { workspace: on ? (size ? { sizeGb: Number(size) } : {}) : null } };
}

/** Rail readout: "Off" or "On". The size has its own row, `workspaceNewClaimSize`. */
export function workspaceLabel(workspace: RuntimePoolWorkspace | null | undefined): string {
  return workspace ? "On" : "Off";
}

/**
 * Rail readout of the size a newly created claim gets, or null when the workspace
 * is off or the kind has no size. The provider reuses an existing claim unchanged,
 * so this is never shown as the size of the claims already in the cluster.
 */
export function workspaceNewClaimSize(
  kind: RuntimeProviderKind,
  workspace: RuntimePoolWorkspace | null | undefined,
): string | null {
  if (!workspace || !workspaceHasSize(kind)) return null;
  return workspace.sizeGb === undefined
    ? `${WORKSPACE_DEFAULT_SIZE_GB} GiB (default)`
    : `${workspace.sizeGb} GiB`;
}
