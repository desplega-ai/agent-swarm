import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import type { UpsertConfigEntry } from "@/api/hooks/use-config-api";
import { type EnvPresenceMap, useReloadConfig } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";

/**
 * Store global config rows from a `/setup` field: write them, apply them to
 * the running API, then refresh the onboarding signals. Quiet on success (the
 * field shows its own save indicator). A failed write toasts and throws, so
 * the indicator shows the error too.
 *
 * Keys written here count as saved before env presence catches up.
 */
export function useSetupSave(presence: EnvPresenceMap = {}) {
  const queryClient = useQueryClient();
  const { mutateAsync: reload } = useReloadConfig();
  const [savedNow, setSavedNow] = useState<ReadonlySet<string>>(() => new Set());

  const save = useCallback(
    async (entries: UpsertConfigEntry[]): Promise<void> => {
      for (const entry of entries) {
        try {
          await api.upsertConfig({
            scope: "global",
            key: entry.key,
            value: entry.value,
            isSecret: entry.isSecret,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Could not save.";
          toast.error(`Could not save ${entry.key}. ${message}`);
          throw err instanceof Error ? err : new Error(message);
        }
      }
      const written = entries.filter((e) => e.value !== "").map((e) => e.key);
      setSavedNow((prev) => new Set([...prev, ...written]));
      // Older APIs do not auto-reload global writes. The reload also refreshes
      // `/status`, env presence, and the config list.
      await reload().catch(() => undefined);
      await queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
    },
    [queryClient, reload],
  );

  return {
    save,
    isSaved: (key: string) => Boolean(presence[key]) || savedNow.has(key),
  };
}
