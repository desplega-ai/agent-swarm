import { AlertCircle } from "lucide-react";
import { lazy, Suspense } from "react";
import { CopyValueButton } from "@/components/shared/copy-value-button";
import { AlertCallout } from "@/components/ui/alert-callout";
import { Skeleton } from "@/components/ui/skeleton";
import { type ObjectFetch, useObject } from "./use-object";

// Code-split: Excalidraw and the grid editor load only when an embed shows one.
const BoardView = lazy(() => import("./board-view"));
const SheetView = lazy(() => import("./sheet-view"));

export const DEFAULT_EMBED_HEIGHT = 480;

export type ObjectEmbedProps = {
  objectId: string;
  /** CSS pixels, 160-1200 (the catalog clamps it). */
  height?: number;
  readOnly?: boolean;
  /** Sheet tab to open first. */
  tab?: string;
  /** Sheet window such as `B2:F20` or `Tab!B2:F20`; a tab here pins it. */
  range?: string;
  /** How to reach `/api/objects/*`; the host supplies its base URL and auth. */
  fetch: ObjectFetch;
  theme?: "light" | "dark";
};

/**
 * One board or sheet by object id, editable in place. Host-agnostic: the host
 * injects `fetch` and `theme`, so an app, a page bundle and Markdown can share it.
 */
export function ObjectEmbed({
  objectId,
  height = DEFAULT_EMBED_HEIGHT,
  readOnly,
  tab,
  range,
  fetch,
  theme,
}: ObjectEmbedProps) {
  const { snapshot, error, refetch, markVersion } = useObject(objectId, fetch);
  const box = "w-full overflow-hidden rounded-md border bg-background";

  if (!snapshot) {
    if (!error) return <Skeleton className={box} style={{ height }} />;
    return (
      <AlertCallout
        tone="error"
        icon={AlertCircle}
        title="Could not load this object"
        action={<CopyValueButton value={objectId} label="Copy object id" size="icon-sm" />}
      >
        {error.message}
      </AlertCallout>
    );
  }

  const kind = snapshot.object.kind;
  return (
    <div className={box} style={{ height }} data-object-kind={kind}>
      <Suspense fallback={<Skeleton className="h-full w-full" />}>
        {kind === "board" ? (
          <BoardView
            snapshot={snapshot}
            fetchFn={fetch}
            refetch={refetch}
            markVersion={markVersion}
            readOnly={readOnly}
            theme={theme}
          />
        ) : kind === "sheet" ? (
          <SheetView
            snapshot={snapshot}
            fetchFn={fetch}
            refetch={refetch}
            readOnly={readOnly}
            tab={tab}
            range={range}
          />
        ) : (
          <p className="p-4 text-sm text-muted-foreground">
            Objects of kind “{kind}” have no embed view.
          </p>
        )}
      </Suspense>
    </div>
  );
}
