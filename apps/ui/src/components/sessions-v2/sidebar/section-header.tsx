/**
 * A plain sidebar section header (My groups, Shared with me): the title, and
 * the number of sessions on the right. Nothing else (SPEC R5). It is drawn
 * only: the tree group it heads carries the same words as its label.
 */
export function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div
      aria-hidden
      className="mx-1.5 mt-3 flex h-7 items-center gap-1.5 pr-2 pl-3 font-mono text-meta text-muted-foreground"
    >
      <span className="min-w-0 flex-1 truncate tracking-widest uppercase">{label}</span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </div>
  );
}
