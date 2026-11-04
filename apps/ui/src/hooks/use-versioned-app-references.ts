import { useCallback, useEffect, useState } from "react";
import type { AppDetail } from "@/api/types";

function sameDefinition(a: AppDetail, b: AppDetail): boolean {
  return JSON.stringify(a.definition) === JSON.stringify(b.definition);
}

/** Hold changed borrowed definitions while allowing newly discovered references to load. */
export function useVersionedAppReferences(
  latest: Map<string, AppDetail>,
  targetIds: string[],
  autoReload: boolean,
) {
  const [displayed, setDisplayed] = useState(() => new Map(latest));
  useEffect(() => {
    setDisplayed((current) => {
      const next = new Map<string, AppDetail>();
      for (const id of targetIds) {
        const previous = current.get(id);
        const incoming = latest.get(id);
        const value = incoming && (!previous || autoReload) ? incoming : previous;
        if (value) next.set(id, value);
      }
      if (
        next.size === current.size &&
        [...next].every(([id, value]) => current.get(id) === value)
      ) {
        return current;
      }
      return next;
    });
  }, [latest, targetIds, autoReload]);

  const pending = [...displayed].some(([id, value]) => {
    const incoming = latest.get(id);
    return incoming !== undefined && !sameDefinition(value, incoming);
  });
  const apply = useCallback(() => setDisplayed(new Map(latest)), [latest]);
  return { value: displayed, pending, apply };
}
