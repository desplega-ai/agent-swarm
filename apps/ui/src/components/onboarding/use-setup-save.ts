import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { type UpsertConfigEntry, useUpsertConfigsBatch } from "@/api/hooks/use-config-api";
import { type EnvPresenceMap, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";

/**
 * Save global config rows from a `/setup` step: write them, apply them to the
 * running API, then refresh the onboarding signals. The batch hook toasts the
 * result, so callers show no second message for a failed write.
 *
 * Keys written here count as saved before env presence catches up. `version`
 * changes after each full save, so a `SecretField` keyed on it returns to its
 * saved view.
 */
export function useSetupSave(presence: EnvPresenceMap = {}) {
  const queryClient = useQueryClient();
  const batch = useUpsertConfigsBatch();
  const reload = useReloadConfig();
  const [savedNow, setSavedNow] = useState<ReadonlySet<string>>(() => new Set());
  const [version, setVersion] = useState(0);

  async function save(entries: UpsertConfigEntry[]): Promise<boolean> {
    const result = await batch
      .mutateAsync(entries.map((entry) => ({ ...entry, scope: "global" as const })))
      .catch(() => null);
    if (!result) return false;
    const failed = new Set(result.errors.map((e) => e.key));
    const written = entries.filter((e) => e.value !== "" && !failed.has(e.key));
    setSavedNow((prev) => new Set([...prev, ...written.map((e) => e.key)]));
    if (result.failureCount > 0) return false;
    setVersion((v) => v + 1);
    // Older APIs do not auto-reload global writes. The reload also refreshes
    // `/status` and env presence.
    await reload.mutateAsync().catch(() => undefined);
    await queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    return true;
  }

  return {
    save,
    saving: batch.isPending || reload.isPending,
    isSaved: (key: string) => Boolean(presence[key]) || savedNow.has(key),
    version,
  };
}
