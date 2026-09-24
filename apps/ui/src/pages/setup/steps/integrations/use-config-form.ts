import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type UpsertConfigEntry, useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import { type EnvPresenceMap, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import type { SwarmConfig } from "@/api/types";
import type { SetupFieldSpec } from "./catalog";

/**
 * Local form state for one integration pane. Secrets start empty: a stored
 * secret renders as saved with a Replace action and never comes back to the
 * browser. Non-secret values start from the stored global row.
 */
export function useConfigForm(
  specs: SetupFieldSpec[],
  configs: SwarmConfig[],
  presence: EnvPresenceMap,
) {
  const queryClient = useQueryClient();
  const upsert = useUpsertConfigsBatch();
  const reload = useReloadConfig();

  const rowFor = (key: string) => configs.find((c) => c.key === key && c.scope === "global");
  const baseline = (s: SetupFieldSpec) => rowFor(s.key)?.value ?? s.defaultValue ?? "";

  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(specs.map((s) => [s.key, s.secret ? "" : baseline(s)])),
  );
  const [replacing, setReplacing] = useState<Record<string, boolean>>({});

  const isSaved = (key: string) => Boolean(presence[key] || rowFor(key));
  const value = (key: string) => values[key] ?? "";

  const entries: UpsertConfigEntry[] = specs.flatMap((s) => {
    const next = value(s.key).trim();
    if (!next) return [];
    if (!s.secret && next === baseline(s)) return [];
    return [{ key: s.key, value: next, isSecret: s.secret, scope: "global" as const }];
  });

  const requiredMet = specs
    .filter((s) => s.required)
    .every((s) => isSaved(s.key) || value(s.key).trim().length > 0);

  /** Save the changed fields, apply them live, then refresh the onboarding signals. */
  async function save(): Promise<boolean> {
    if (entries.length === 0) return false;
    const result = await upsert.mutateAsync(entries);
    if (result.failureCount > 0) return false;
    setValues((prev) => {
      const next = { ...prev };
      for (const s of specs) if (s.secret) next[s.key] = "";
      return next;
    });
    setReplacing({});
    await reload.mutateAsync().catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    return true;
  }

  return {
    value,
    setValue: (key: string, next: string) => setValues((prev) => ({ ...prev, [key]: next })),
    isSaved,
    /** Stored on the server but not readable here (deployment env, no row). */
    isEnvOnly: (key: string) => Boolean(presence[key] && !rowFor(key)),
    isReplacing: (key: string) => replacing[key] === true,
    setReplacing: (key: string, on: boolean) => {
      setReplacing((prev) => ({ ...prev, [key]: on }));
      if (!on) setValues((prev) => ({ ...prev, [key]: "" }));
    },
    dirty: entries.length > 0,
    requiredMet,
    saving: upsert.isPending || reload.isPending,
    save,
  };
}

export type ConfigForm = ReturnType<typeof useConfigForm>;

/** Props every integration pane receives from the step. */
export interface PaneProps {
  configs: SwarmConfig[];
  presence: EnvPresenceMap;
  connected: boolean;
}
