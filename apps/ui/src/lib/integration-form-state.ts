import type { UpsertConfigEntry } from "@/api/hooks/use-config-api";
import type { SwarmConfig } from "@/api/types";
import {
  getIntegrationFields,
  type IntegrationDef,
  type IntegrationField,
} from "./integrations-catalog";
import { findConfigForKey } from "./integrations-status";

// Server returns "********" for secret values unless ?includeSecrets=true.
export const SECRET_MASK_SENTINEL = "********";

export interface DirtyField {
  value: string;
  markedForReplace?: boolean;
}

export type DirtyState = Record<string, DirtyField>;

// Build the initial form state:
//  - Non-secret fields: pre-fill with the existing plaintext value (these are
//    harmless — channel names, emails, flags, etc.).
//  - Secret fields with an existing row: store the "********" sentinel so the
//    renderer shows masked read-only + Replace.
export function buildInitialState(def: IntegrationDef, configs: SwarmConfig[]): DirtyState {
  const state: DirtyState = {};
  for (const f of getIntegrationFields(def)) {
    const existing = findConfigForKey(configs, f.key);
    if (!existing) {
      state[f.key] = { value: f.default ?? "" };
      continue;
    }
    state[f.key] = {
      value: f.isSecret ? SECRET_MASK_SENTINEL : existing.value,
    };
  }
  return state;
}

/**
 * Carry stored values into the form after the configs change underneath it
 * (another editor on the page saved the same keys, e.g. the Memory probe).
 * A field the operator has not touched still equals the old baseline, so it
 * takes the new stored value. A field they edited keeps their edit.
 */
export function reconcileWithStored(
  state: DirtyState,
  previousBaseline: DirtyState,
  nextBaseline: DirtyState,
): DirtyState {
  const next: DirtyState = { ...state };
  for (const [key, stored] of Object.entries(nextBaseline)) {
    const current = state[key];
    const untouched =
      !current ||
      (!current.markedForReplace && current.value === (previousBaseline[key]?.value ?? ""));
    if (untouched) next[key] = stored;
  }
  return next;
}

// A field is dirty when:
//   - Secret + existing row + Replace clicked + non-mask value typed → send.
//   - Secret + no existing row + non-empty value typed → send.
//   - Non-secret + value differs from the stored value → send.
export function computeDirtyEntries(
  fields: IntegrationField[],
  state: DirtyState,
  configs: SwarmConfig[],
): UpsertConfigEntry[] {
  const entries: UpsertConfigEntry[] = [];
  for (const f of fields) {
    const current = state[f.key];
    if (!current) continue;
    const existing = findConfigForKey(configs, f.key);

    if (f.isSecret) {
      if (existing && !current.markedForReplace) continue;
      if (!current.value) continue;
      if (current.value === SECRET_MASK_SENTINEL) continue;
    } else {
      const prevValue = existing?.value ?? "";
      if (current.value === prevValue) continue;
    }

    entries.push({
      key: f.key,
      value: current.value,
      isSecret: f.isSecret === true,
      description: null,
      envPath: null,
      scope: "global",
    });
  }
  return entries;
}
