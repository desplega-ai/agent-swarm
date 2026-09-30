import { type ReactNode, useState } from "react";
import { refreshCatalogNow, useModels } from "../hooks.ts";
import { fmtAgo, fmtDate } from "./format.ts";
import { Tooltip } from "./Tooltip.tsx";
import "./catalog-badge.css";

const SOURCE_LABELS: Record<string, string> = {
  live: "live",
  db: "cached",
  snapshot: "snapshot",
};

/**
 * Where the model catalog behind every model name, price and alias resolution
 * comes from (live models.dev fetch, the last persisted fetch, or the committed
 * snapshot), how old it is, and a button to refetch it now instead of waiting
 * for the server's 6h revalidation. `onRefreshed` lets a page reload its own data.
 */
export function CatalogBadge(props: { onRefreshed?: () => void }): ReactNode {
  const { catalog } = useModels();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (catalog === null) return null;

  const refresh = async () => {
    setBusy(true);
    setError(null);
    try {
      await refreshCatalogNow();
      props.onRefreshed?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const source = SOURCE_LABELS[catalog.source] ?? catalog.source;
  const detail =
    catalog.fetchedAt !== null
      ? `Fetched from models.dev ${fmtDate(catalog.fetchedAt)}`
      : "Committed snapshot: no live models.dev fetch has succeeded on this server yet";
  return (
    <span className="catalog-badge">
      <Tooltip text={`${detail}. Model ids stay limited to the reviewed snapshot.`}>
        <span className={`chip catalog-badge-chip catalog-badge-${catalog.source}`}>
          models.dev · {source}
          {catalog.fetchedAt !== null ? ` · ${fmtAgo(catalog.fetchedAt)}` : ""}
        </span>
      </Tooltip>
      <button type="button" className="btn" onClick={refresh} disabled={busy}>
        {busy ? "Refreshing…" : "Refresh catalog"}
      </button>
      {error ? <span className="cfg-error">{error}</span> : null}
    </span>
  );
}
