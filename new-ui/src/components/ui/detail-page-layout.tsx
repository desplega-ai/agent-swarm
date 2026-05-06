import { ChevronRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";

// DetailPageLayout — canonical detail-page body shell, derived from the brand
// kit's `~/Downloads/swarm-design-system/preview/detail-page-template.html`.
// Every detail page in new-ui (agents, tasks, repos, schedules, integrations,
// mcp-servers, skills, approval-requests, …) shares the same body layout:
//
//   <main>{primary content}</main>
//   <aside class="rail">
//     <h4>Quick stats</h4>          (4× stat rows)
//     <h4>Relationships</h4>        (n× linked-resource rows)
//     <h4>Danger zone</h4>          (full-width destructive button)
//   </aside>
//
// The brand kit fixes the rail at 280px; below `lg` the rail stacks beneath
// the main content.
//
// Pages keep their existing <PageHeader> for the title row above this body —
// we don't re-implement that here; the primitive is purely about the body
// layout + rail sections.
//
// USAGE
//
//   <DetailPageBody
//     main={<MainContent />}
//     rail={
//       <DetailPageRail>
//         <QuickStats>
//           <QuickStat label="Created" value="May 5" />
//           …
//         </QuickStats>
//         <Relationships>
//           <Relationship label="Owner" to="/agents/abc">tarasyarema</Relationship>
//         </Relationships>
//         <DangerZone>
//           <Button variant="destructive-outline" className="w-full">Delete</Button>
//         </DangerZone>
//       </DetailPageRail>
//     }
//   />
//
// Pages without rail content omit `rail` — main expands to full width.
// Pages with only some rail sections omit the unused subsections.

// ---------------------------------------------------------------------------
// Body — 2-col grid (1fr | 280px) with optional rail.
// ---------------------------------------------------------------------------

export interface DetailPageBodyProps {
  main: ReactNode;
  rail?: ReactNode;
  className?: string;
}

export function DetailPageBody({ main, rail, className }: DetailPageBodyProps) {
  if (!rail) {
    return <div className={cn("flex flex-col gap-4", className)}>{main}</div>;
  }
  // Phase 17 — `min-h-0 lg:min-h-0` on the inner main/aside containers so
  // descendants with their own `flex-1 + overflow-auto` (Monaco editors,
  // <pre> blocks, log viewers) can actually shrink + scroll when the parent
  // page passes `className="flex-1 min-h-0"`. Without this, the lg:grid row
  // had implicit `auto` height on each cell, forcing children to overflow
  // the page and break scroll across detail pages adopting <DetailPageBody>.
  return (
    <div className={cn("flex flex-col lg:grid lg:grid-cols-[1fr_280px] gap-6 lg:gap-8", className)}>
      <div className="min-w-0 min-h-0 flex flex-col">{main}</div>
      <aside className="lg:border-l lg:border-border lg:pl-6 min-w-0 min-h-0 flex flex-col">
        {rail}
      </aside>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Rail — flex-col container for sections. Just spacing/padding.
// ---------------------------------------------------------------------------

export interface DetailPageRailProps {
  children: ReactNode;
  className?: string;
}

export function DetailPageRail({ children, className }: DetailPageRailProps) {
  return <div className={cn("flex flex-col", className)}>{children}</div>;
}

// ---------------------------------------------------------------------------
// Section — h4 heading + content, mirrors the brand kit's `.right h4` style:
//   font-mono · 10px · 700 · uppercase · tracking 0.08em · muted color
//   first section: mb-2.5 only
//   subsequent sections: mt-5 mb-2.5
// ---------------------------------------------------------------------------

export interface DetailPageSectionProps {
  title: ReactNode;
  children: ReactNode;
  className?: string;
}

export function DetailPageSection({ title, children, className }: DetailPageSectionProps) {
  return (
    <section className={cn("first:mt-0 mt-5", className)}>
      <h4 className="font-mono font-bold text-[10px] uppercase tracking-[0.08em] text-muted-foreground mb-2.5">
        {title}
      </h4>
      {children}
    </section>
  );
}

// ---------------------------------------------------------------------------
// QuickStats — Quick stats section, holds <QuickStat> rows.
// ---------------------------------------------------------------------------

export interface QuickStatsProps {
  children: ReactNode;
  title?: ReactNode;
  className?: string;
}

export function QuickStats({ children, title = "Quick stats", className }: QuickStatsProps) {
  return (
    <DetailPageSection title={title} className={className}>
      <div className="flex flex-col">{children}</div>
    </DetailPageSection>
  );
}

// QuickStat row: 2-col grid `1fr auto`, key in muted, value right-aligned.
// `mono` switches the value to font-mono (matches the brand kit's `.v.mono`).

export interface QuickStatProps {
  label: ReactNode;
  value: ReactNode;
  mono?: boolean;
  className?: string;
}

export function QuickStat({ label, value, mono = false, className }: QuickStatProps) {
  return (
    <div className={cn("grid grid-cols-[1fr_auto] gap-2 py-1 text-xs items-baseline", className)}>
      <span className="text-muted-foreground min-w-0 truncate">{label}</span>
      <span
        className={cn(
          "text-foreground font-medium text-right min-w-0 truncate",
          mono && "font-mono text-[11.5px]",
        )}
      >
        {value}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Relationships — Relationships section, holds <Relationship> rows.
// ---------------------------------------------------------------------------

export interface RelationshipsProps {
  children: ReactNode;
  title?: ReactNode;
  className?: string;
}

export function Relationships({
  children,
  title = "Relationships",
  className,
}: RelationshipsProps) {
  return (
    <DetailPageSection title={title} className={className}>
      <div className="flex flex-col">{children}</div>
    </DetailPageSection>
  );
}

// Relationship row: `label` + arrow on the right. Renders an internal Link
// (react-router) when `to` is provided, an external <a> when `href` is, or
// a plain row when neither (rare — useful for placeholder/disabled rels).

export interface RelationshipProps {
  label: ReactNode;
  to?: string;
  href?: string;
  children?: ReactNode;
  className?: string;
}

export function Relationship({ label, to, href, children, className }: RelationshipProps) {
  const valueNode = children ?? (
    <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
  );

  const inner = (
    <>
      <span className="text-muted-foreground min-w-0 truncate">{label}</span>
      <span className="text-foreground font-medium text-right min-w-0 truncate flex items-center gap-1 justify-end">
        {valueNode}
      </span>
    </>
  );

  const baseClasses = cn(
    "grid grid-cols-[1fr_auto] gap-2 py-1 text-xs items-baseline",
    (to || href) && "hover:bg-muted/30 -mx-2 px-2 rounded transition-colors",
    className,
  );

  if (to) {
    return (
      <Link to={to} className={baseClasses}>
        {inner}
      </Link>
    );
  }

  if (href) {
    return (
      <a href={href} target="_blank" rel="noopener noreferrer" className={baseClasses}>
        {inner}
      </a>
    );
  }

  return <div className={baseClasses}>{inner}</div>;
}

// ---------------------------------------------------------------------------
// DangerZone — opinionated section heading + content slot. Pages drop a
// destructive-outline button (or AlertDialog trigger) inside.
// ---------------------------------------------------------------------------

export interface DangerZoneProps {
  children: ReactNode;
  className?: string;
}

export function DangerZone({ children, className }: DangerZoneProps) {
  return (
    <DetailPageSection title="Danger zone" className={className}>
      <div className="flex flex-col gap-2">{children}</div>
    </DetailPageSection>
  );
}
