import { ChevronRight } from "lucide-react";
import { useState } from "react";
import { CollapsibleSection } from "@/components/shared/collapsible-section";
import { COMPOSITION_SWATCH, compositionTokens } from "@/components/shared/request-composition-bar";
import { formatTokens } from "@/lib/format-tokens";
import {
  type CompositionAnchor,
  type CompositionManifest,
  type CompositionPart,
  compositionGroupOf,
  partTokens,
} from "@/lib/request-composition";
import { cn } from "@/lib/utils";
import { NARROW_TARGET } from "./touch-targets";

/** The rail's manifest: the task's latest session, and its first main call. */
export interface RailComposition {
  manifest: CompositionManifest;
  anchor?: CompositionAnchor;
  /** Sessions with a manifest. Above 1, the section names the one it shows. */
  sessions: number;
}

type Fidelity = CompositionPart["fidelity"] | "derived";

interface Row {
  key: string;
  label: string;
  tokens: number;
  fidelity: Fidelity;
  swatch: string;
  children?: Row[];
}

function partRow(part: CompositionPart, manifest: CompositionManifest): Row {
  return {
    key: `${part.kind}:${part.id}`,
    label: part.label,
    tokens: partTokens(part, manifest),
    fidelity: part.fidelity,
    swatch: COMPOSITION_SWATCH[compositionGroupOf(part.kind)],
  };
}

/** Largest first. System sections fold into one row; the harness base is last. */
function compositionRows(manifest: CompositionManifest, anchor?: CompositionAnchor): Row[] {
  const sections: Row[] = [];
  const rows: Row[] = [];
  for (const part of manifest.parts) {
    (part.kind === "system_section" ? sections : rows).push(partRow(part, manifest));
  }
  const byTokens = (a: Row, b: Row) => b.tokens - a.tokens;
  if (sections.length > 0) {
    rows.push({
      key: "system",
      label: `System prompt sections (${sections.length})`,
      tokens: sections.reduce((sum, r) => sum + r.tokens, 0),
      fidelity: sections.some((r) => r.fidelity === "estimate") ? "estimate" : "exact",
      swatch: COMPOSITION_SWATCH.system,
      children: sections.sort(byTokens),
    });
  }
  rows.sort(byTokens);
  if (anchor) {
    rows.push({
      key: "harness",
      label: "Harness base (unattributed)",
      tokens: anchor.residualTokens,
      fidelity: "derived",
      swatch: COMPOSITION_SWATCH.harness,
    });
  }
  return rows;
}

const FIDELITY_LABEL: Record<Fidelity, string> = {
  exact: "exact",
  estimate: "est.",
  derived: "derived",
};

function FidelityBadge({ fidelity }: { fidelity: Fidelity }) {
  return (
    <span
      className={cn(
        "rounded-sm border px-1 font-sans text-meta leading-4",
        fidelity === "exact"
          ? "border-status-success/40 text-status-success-strong"
          : "border-border text-muted-foreground",
      )}
    >
      {FIDELITY_LABEL[fidelity]}
    </span>
  );
}

function CompositionRow({
  row,
  firstCall,
  nested = false,
}: {
  row: Row;
  firstCall?: number;
  nested?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const share = firstCall ? `${Math.round((row.tokens / firstCall) * 100)}%` : "—";
  const label = (
    <span className="flex min-w-0 flex-1 items-center gap-1.5">
      {row.children ? (
        <ChevronRight
          className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")}
          aria-hidden
        />
      ) : null}
      <span className={cn("size-2 shrink-0 rounded-sm", row.swatch)} aria-hidden />
      <span className="truncate font-sans" title={row.label}>
        {row.label}
      </span>
    </span>
  );
  return (
    <>
      <li
        className={cn("flex items-center gap-2", nested && "pl-5")}
        data-testid="composition-row"
        data-tokens={row.tokens}
      >
        {row.children ? (
          <button
            type="button"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 cursor-pointer items-center rounded-sm text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
          >
            {label}
          </button>
        ) : (
          label
        )}
        <span className="shrink-0">{compositionTokens(row.tokens, row.fidelity !== "exact")}</span>
        <span className="w-8 shrink-0 text-right text-muted-foreground">{share}</span>
        <span className="w-12 shrink-0 text-right">
          <FidelityBadge fidelity={row.fidelity} />
        </span>
      </li>
      {open && row.children
        ? row.children.map((child) => (
            <CompositionRow key={child.key} row={child} firstCall={firstCall} nested />
          ))
        : null}
    </>
  );
}

/**
 * What the task's prompt is made of, in tokens: each static part the worker
 * measured, and the harness base the first call shows on top of them.
 */
export function RequestCompositionSection({ composition }: { composition: RailComposition }) {
  const { manifest, anchor, sessions } = composition;
  const rows = compositionRows(manifest, anchor);
  const firstCall = anchor?.promptTokens;
  return (
    <CollapsibleSection
      title="Request composition"
      persistKey="tasks:request-composition-open"
      defaultOpen
      headerClassName={NARROW_TARGET}
      heading="h2"
      titleClassName="text-meta"
    >
      <div className="space-y-2 pt-1" data-testid="request-composition">
        <p className="flex items-baseline justify-between gap-3 font-mono text-data tabular-nums">
          <span>
            <span className="font-sans text-muted-foreground">First call </span>
            {firstCall ? `${formatTokens(firstCall)} tokens` : "not yet"}
          </span>
          <span className="text-muted-foreground">
            {sessions > 1 ? `latest of ${sessions} sessions` : manifest.provider}
          </span>
        </p>
        <ul className="space-y-1 font-mono text-meta tabular-nums">
          {rows.map((row) => (
            <CompositionRow key={row.key} row={row} firstCall={firstCall} />
          ))}
        </ul>
        <p className="text-xs text-muted-foreground">
          {manifest.source === "harness-hook"
            ? "Measured from the request the harness sent."
            : "Estimates are characters ÷ 4. The harness base is the first call minus our parts."}
        </p>
      </div>
    </CollapsibleSection>
  );
}
