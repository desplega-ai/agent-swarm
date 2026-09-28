import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { invalidateStatusQuery } from "@/api/hooks/status-query";
import type { UpsertConfigEntry } from "@/api/hooks/use-config-api";
import type { EnvPresenceMap } from "@/api/hooks/use-integrations-meta";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";

/**
 * The API applies global rows to its env (and restarts integrations) about
 * 250 ms after the last write, coalesced. Reads that come from that env
 * (`/status`, env presence, onboarding signals) refresh once after this delay.
 */
const SERVER_RELOAD_SETTLE_MS = 750;

// One timer for every field on the page: a burst of saves refreshes once.
let settleTimer: number | undefined;

function refreshAfterSave(queryClient: QueryClient): Promise<unknown> {
  window.clearTimeout(settleTimer);
  settleTimer = window.setTimeout(() => {
    void invalidateStatusQuery(queryClient);
    void queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] });
    void queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY });
  }, SERVER_RELOAD_SETTLE_MS);
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: ["configs"] }),
    queryClient.invalidateQueries({ queryKey: ["config", "env-presence"] }),
    queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY }),
  ]);
}

/**
 * Store global config rows from a `/setup` field, then refresh what reads
 * them. No explicit `/api/config/reload`: every global write already
 * schedules one on the server, and a second one restarts Slack and the other
 * integrations twice. Quiet on success (the field shows its own indicator).
 *
 * A failed write reports which keys saved and which did not, toasts once per
 * distinct error (not on every typing pause), and throws, so the indicator
 * shows the error too. Keys written here count as saved before env presence
 * catches up.
 */
export function useSetupSave(presence: EnvPresenceMap = {}) {
  const queryClient = useQueryClient();
  const [savedNow, setSavedNow] = useState<ReadonlySet<string>>(() => new Set());
  const toasted = useRef(new Set<string>());

  const save = useCallback(
    async (entries: UpsertConfigEntry[]): Promise<void> => {
      const saved: UpsertConfigEntry[] = [];
      const failed: Array<{ key: string; message: string }> = [];
      for (const entry of entries) {
        try {
          await api.upsertConfig({
            scope: "global",
            key: entry.key,
            value: entry.value,
            isSecret: entry.isSecret,
          });
          saved.push(entry);
        } catch (err) {
          failed.push({
            key: entry.key,
            message: err instanceof Error ? err.message : "Could not save.",
          });
        }
      }

      if (saved.length > 0) {
        // A blank value clears the row: it does not count as saved.
        const stored = saved.filter((e) => e.value !== "").map((e) => e.key);
        setSavedNow((prev) => new Set([...prev, ...stored]));
        await refreshAfterSave(queryClient);
      }
      if (failed.length === 0) {
        toasted.current.clear();
        return;
      }

      const keys = failed.map((f) => f.key).join(", ");
      const partly = saved.length > 0 ? ` Saved ${saved.map((e) => e.key).join(", ")}.` : "";
      const message = `Could not save ${keys}. ${failed[0].message}${partly}`;
      const errorKey = `${keys}\n${failed[0].message}`;
      if (!toasted.current.has(errorKey)) {
        toasted.current.add(errorKey);
        // The id also lets the shell show the same error without a second toast.
        toast.error(message, { id: message });
      }
      throw new Error(message);
    },
    [queryClient],
  );

  return {
    save,
    isSaved: (key: string) => Boolean(presence[key]) || savedNow.has(key),
  };
}
