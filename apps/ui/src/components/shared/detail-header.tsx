/**
 * The compact header for a detail page (mockup, UI audit 2026-11-06).
 *
 * One line holds what a reader needs first: status, the key badges and the
 * primary action. Everything else waits one tap away:
 *
 * - desktop: back link, status + badges + actions on one row, the facts as a
 *   single row of label/value pairs, the description clamped to 2 lines;
 * - phone: no back link (the phone bar's title menu goes up a level). ONE
 *   row: status, a summary ("19m ago · 14 steps ▾") that expands to the
 *   badges and facts, the primary action and "More actions". The
 *   description clamps to 2 lines.
 *
 * The phone header stays under ~90px however many badges or facts a page
 * has, so the page's primary content starts in the top fifth of the screen.
 */

import { ArrowLeft, ChevronDown } from "lucide-react";
import { type ReactNode, useState } from "react";
import { Link } from "react-router-dom";
import { PageActions } from "@/components/shared/page-actions";
import { ShowMore } from "@/components/shared/show-more";
import { useIsPhone } from "@/hooks/use-mobile";
import { cn } from "@/lib/utils";

export interface DetailFact {
  label: string;
  value: ReactNode;
  /** Short plain text for the phone summary line. Omit to keep the fact out of it. */
  summary?: string;
}

export function DetailHeader({
  back,
  title,
  status,
  badges,
  facts,
  description,
  actions,
  primary,
  more,
  className,
}: {
  back?: { to: string; label: string };
  /** The entity name; the phone bar truncates it, so the sheet titles use it. */
  title: string;
  status?: ReactNode;
  /** Secondary chips: inline on desktop, behind the summary line on a phone. */
  badges?: ReactNode[];
  facts?: DetailFact[];
  description?: ReactNode;
  /** Desktop action cluster. */
  actions?: ReactNode;
  /** Phone: the one action that stays on the header line (an icon button). */
  primary?: ReactNode;
  /** Phone: the rest, as `ActionSheetItem` rows in the "More actions" sheet. */
  more?: ReactNode;
  className?: string;
}) {
  const isPhone = useIsPhone();
  const [open, setOpen] = useState(false);
  const chips = (badges ?? []).filter(Boolean);
  const allFacts = facts ?? [];

  const descriptionNode = description ? (
    <ShowMore maxHeight="calc(1.25rem * var(--clamp-lines))" className="[--clamp-lines:2]">
      <p className="text-sm leading-5 text-muted-foreground">{description}</p>
    </ShowMore>
  ) : null;

  if (isPhone) {
    const summary = allFacts.map((f) => f.summary).filter(Boolean);
    return (
      <div data-slot="detail-header" className={cn("flex flex-col gap-1.5", className)}>
        <div className="flex min-h-11 items-center gap-2">
          <div className="flex shrink-0 items-center gap-2">{status}</div>
          {summary.length > 0 || chips.length > 0 ? (
            <button
              type="button"
              aria-expanded={open}
              aria-label={open ? "Hide details" : "Show details"}
              onClick={() => setOpen((v) => !v)}
              className="flex min-h-11 min-w-0 flex-1 items-center gap-1 text-left text-xs text-muted-foreground"
            >
              <span className="min-w-0 truncate">{summary.join(" · ") || "Details"}</span>
              <ChevronDown
                className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")}
                aria-hidden
              />
            </button>
          ) : (
            <div className="flex-1" />
          )}
          {more ? (
            <PageActions title={title} primary={primary} more={more}>
              {null}
            </PageActions>
          ) : (
            primary
          )}
        </div>
        {open ? (
          <div className="flex flex-col gap-3 rounded-lg border bg-card px-3 py-3">
            {chips.length > 0 ? <div className="flex flex-wrap gap-2">{chips}</div> : null}
            {allFacts.length > 0 ? (
              <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
                {allFacts.map((f) => (
                  <FactItem key={f.label} fact={f} />
                ))}
              </dl>
            ) : null}
          </div>
        ) : null}
        {descriptionNode}
      </div>
    );
  }

  return (
    <div data-slot="detail-header" className={cn("flex flex-col gap-2", className)}>
      <div className="flex min-h-9 items-center gap-3">
        {back ? (
          <Link
            to={back.to}
            className="inline-flex shrink-0 items-center gap-1 text-sm text-muted-foreground transition-colors hover:text-foreground"
          >
            <ArrowLeft className="h-4 w-4" /> {back.label}
          </Link>
        ) : null}
        {back && (status || chips.length > 0) ? (
          <span aria-hidden className="h-4 w-px bg-border" />
        ) : null}
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
          {status}
          {chips}
        </div>
        {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      {allFacts.length > 0 ? (
        <dl className="flex flex-wrap items-start gap-x-8 gap-y-2 rounded-lg border bg-card px-4 py-2">
          {allFacts.map((f) => (
            <FactItem key={f.label} fact={f} />
          ))}
        </dl>
      ) : null}
      {descriptionNode}
    </div>
  );
}

function FactItem({ fact }: { fact: DetailFact }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        {fact.label}
      </dt>
      <dd className="min-w-0 text-sm [overflow-wrap:anywhere]">{fact.value}</dd>
    </div>
  );
}
