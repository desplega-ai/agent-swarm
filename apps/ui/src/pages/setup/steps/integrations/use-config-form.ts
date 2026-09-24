import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import type { SwarmConfig } from "@/api/types";
import { useSetupSave } from "@/components/onboarding/use-setup-save";
import type { SetupFieldSpec } from "./catalog";

/**
 * Stored state for one integration pane. Every field saves itself (see
 * `SetupField`): secrets are write-only and never come back to the browser,
 * non-secret values start from the stored global row.
 */
export function useConfigForm(configs: SwarmConfig[], presence: EnvPresenceMap) {
  const setupSave = useSetupSave(presence);
  const rowFor = (key: string) => configs.find((c) => c.key === key && c.scope === "global");

  return {
    /** The value a non-secret field starts from: the stored row, else its default. */
    baseline: (s: SetupFieldSpec) => rowFor(s.key)?.value ?? s.defaultValue ?? "",
    isSaved: (key: string) => setupSave.isSaved(key) || Boolean(rowFor(key)),
    /** Stored on the server but not readable here (deployment env, no row). */
    isEnvOnly: (key: string) => Boolean(presence[key] && !rowFor(key)),
    /** Store one field, apply it live, then refresh the onboarding signals. */
    saveField: (s: SetupFieldSpec, value: string) =>
      setupSave.save([{ key: s.key, value, isSecret: s.secret }]),
  };
}

export type ConfigForm = ReturnType<typeof useConfigForm>;

/** Props every integration pane receives from the step. */
export interface PaneProps {
  configs: SwarmConfig[];
  presence: EnvPresenceMap;
  connected: boolean;
}
