/**
 * Role-aware UI: what the caller's grants allow, read from `GET /api/whoami`.
 *
 * Hiding is a convenience. The server stays the source of truth and still
 * rejects a call the role cannot make. So when the grants are unknown (an
 * operator-key tab, a pending or failed whoami, an older API that sends no
 * `grants`), every check answers `true` and the UI shows everything, as it
 * did before roles existed.
 *
 * `CurrentUserProvider` publishes the state through `GrantsContext`. Outside
 * that provider the default state is "operator tab", so a component rendered
 * on its own keeps every control.
 *
 * Only relative imports here: root-run tests import this module directly and
 * cannot resolve the `@/` alias.
 */

import { createContext, useContext } from "react";
import type { WhoamiGrants } from "../api/types";

export interface GrantsState {
  /** The tab holds the operator key (or whoami answered `kind: "operator"`). */
  operatorTab: boolean;
  /** A token-bound tab whose whoami has not answered yet. */
  pending: boolean;
  /** Absent on an older API, or when whoami failed. */
  grants: WhoamiGrants | undefined;
}

const UNKNOWN_GRANTS: GrantsState = { operatorTab: true, pending: false, grants: undefined };

export const GrantsContext = createContext<GrantsState>(UNKNOWN_GRANTS);

/** `true` unless the grants are known and lack `verb`. */
export function canWithGrants(
  grants: WhoamiGrants | undefined,
  verb: string,
  opts: { operatorTab: boolean; pending: boolean },
): boolean {
  if (opts.operatorTab || opts.pending || !grants) return true;
  return grants.grantsAll || grants.verbs.includes(verb);
}

/** `true` unless the grants are known and do not grant everything. */
export function isAdminWithGrants(
  grants: WhoamiGrants | undefined,
  opts: { operatorTab: boolean; pending: boolean },
): boolean {
  if (opts.operatorTab || opts.pending || !grants) return true;
  return grants.grantsAll;
}

export function useGrantsState(): GrantsState {
  return useContext(GrantsContext);
}

/** Whether the caller may use `verb`. `true` while the grants are unknown. */
export function useCan(verb: string): boolean {
  const state = useGrantsState();
  return canWithGrants(state.grants, verb, state);
}

/** Whether the caller holds a grants-all role. `true` while the grants are unknown. */
export function useIsAdmin(): boolean {
  const state = useGrantsState();
  return isAdminWithGrants(state.grants, state);
}

/** `true` for operator-key tabs, and once whoami has answered with `grants`. */
export function useGrantsKnown(): boolean {
  const state = useGrantsState();
  return state.operatorTab || (!state.pending && state.grants !== undefined);
}
