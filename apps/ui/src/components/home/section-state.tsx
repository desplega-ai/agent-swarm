/**
 * Read states of a Home widget. Every widget tells a failed read apart from
 * an empty one: "Nothing running" when the request failed would reassure the
 * operator about a swarm nobody can see.
 */

import { AlertTriangle } from "lucide-react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";

/** The slice of a react-query result a section needs to render every state. */
export interface SectionQuery<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
  /**
   * Failed fetches so far. A refetch after an error resets `isError` to a
   * loading state while it runs; this keeps a section that has never loaded
   * showing "unavailable" instead of flickering back to a skeleton.
   */
  errorUpdateCount: number;
  refetch: () => unknown;
}

/** Nothing cached and at least one failed read: the section is unavailable. */
export function isUnavailable(query: SectionQuery<unknown>): boolean {
  return query.data === undefined && (query.isError || query.errorUpdateCount > 0);
}

/**
 * Renders the section's list, or an "unavailable" state when the read failed
 * with nothing cached. With cached data and a failed refresh, the list stays
 * and a stale notice sits above it.
 */
export function SectionBody({
  query,
  what,
  children,
}: {
  query: SectionQuery<unknown>;
  what: string;
  children: ReactNode;
}) {
  if (isUnavailable(query)) {
    return <Unavailable what={what} onRetry={query.refetch} />;
  }
  return (
    <>
      {query.isError ? <StaleNotice onRetry={query.refetch} /> : null}
      {children}
    </>
  );
}

export function Unavailable({ what, onRetry }: { what: string; onRetry: () => unknown }) {
  return (
    <div role="alert" className="flex items-center gap-3 px-4 py-3">
      <AlertTriangle className="size-4 shrink-0 text-status-error-strong" aria-hidden />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="text-sm font-medium">Couldn't load {what}</span>
        <span className="text-xs text-muted-foreground">Unknown, not empty. Check the API.</span>
      </span>
      <Button variant="outline" size="sm" className="shrink-0" onClick={() => onRetry()}>
        Retry
      </Button>
    </div>
  );
}

export function StaleNotice({ onRetry }: { onRetry: () => unknown }) {
  return (
    <p className="flex items-center gap-2 px-4 py-1.5 text-xs text-status-warning-strong">
      <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">Refresh failed. Showing earlier data.</span>
      <button
        type="button"
        onClick={() => onRetry()}
        className="inline-flex items-center px-1 underline underline-offset-2 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
      >
        Retry
      </button>
    </p>
  );
}
