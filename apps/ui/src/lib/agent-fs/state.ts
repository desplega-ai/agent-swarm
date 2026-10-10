// Pure rules behind Comb: the connection state (`AgentFsProvider`), the `/file`
// redirect (`pages/comb/page.tsx`), and the sidebar item (`app-sidebar.tsx`).

import type { StatusComb } from "../../api/types";
import { AgentFsError, isAgentFsAuthError } from "./client";
import type { MeResponse } from "./types";

/**
 * - `disabled`: Comb is off, agent-fs is not configured, or the API predates Comb.
 * - `loading`: `/status` or the identity check is in flight.
 * - `needs-connect`: no credential in this browser.
 * - `invalid-key`: agent-fs rejected the saved key (401).
 * - `unreachable`: the identity check failed for another reason (network, 5xx).
 * - `ready`: `me` is loaded and `client` works.
 */
export type AgentFsState =
  | "disabled"
  | "loading"
  | "needs-connect"
  | "invalid-key"
  | "unreachable"
  | "ready";

/** The browser-facing agent-fs URL while Comb is on. Null when Comb is off. */
export function combEndpoint(comb: StatusComb | undefined): string | null {
  return comb?.enabled && comb.api_url ? comb.api_url : null;
}

/** Sidebar `NavItem.requires`: a `comb` item shows only while Comb is on. */
export function navRequirementMet(
  requires: "comb" | undefined,
  comb: StatusComb | undefined,
): boolean {
  return requires !== "comb" || combEndpoint(comb) !== null;
}

/**
 * Where `/file` (no drive in the URL) goes: the swarm drive, once Comb is on
 * and `/status` names the drive. Null keeps the page (for example "Comb is off").
 */
export function fileRedirectPath(
  routeOrgId: string | undefined,
  drive: { endpoint: string | null; orgId: string | null; driveId: string | null },
): string | null {
  if (routeOrgId || !drive.endpoint || !drive.orgId || !drive.driveId) return null;
  return `/file/~/${drive.orgId}/${drive.driveId}/`;
}

export interface AgentFsStateInput {
  /** `/status` has not answered yet. */
  statusLoading: boolean;
  /** `combEndpoint()` of the `/status` comb block. */
  endpoint: string | null;
  /** This browser has a saved credential for `endpoint`. */
  hasCredential: boolean;
  /** Last `me` result, possibly cached from before an error. */
  me: MeResponse | undefined;
  /** Last `me` error. */
  meError: unknown;
}

export function deriveAgentFsState(input: AgentFsStateInput): {
  state: AgentFsState;
  /** Why the state is `invalid-key` or `unreachable`. Null otherwise. */
  error: AgentFsError | null;
} {
  const meError = input.meError
    ? input.meError instanceof AgentFsError
      ? input.meError
      : new AgentFsError(0, "UNKNOWN", "agent-fs identity check failed")
    : null;
  let state: AgentFsState;
  if (input.statusLoading) state = "loading";
  else if (!input.endpoint) state = "disabled";
  else if (!input.hasCredential) state = "needs-connect";
  // A 401 wins over cached data: the key was revoked or reset since.
  else if (isAgentFsAuthError(meError)) state = "invalid-key";
  else if (input.me) state = "ready";
  else if (meError) state = "unreachable";
  else state = "loading";
  return { state, error: state === "invalid-key" || state === "unreachable" ? meError : null };
}
