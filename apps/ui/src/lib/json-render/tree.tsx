/**
 * `Tree` — a collapsible outline of a json-render flat element map.
 *
 * `nodes` is a doc-shaped value (`{ root: string | string[], elements:
 * Record<key, {type, children?}> }`), usually a `{$state}` binding to a json
 * column holding such a value. Each row renders `key — type`; clicking one
 * writes the node key to `/ui/<id>/value` (the same interactivity root
 * SearchInput/Select own), and the row bound to that path renders as selected.
 * A malformed or absent `nodes` value renders an empty state rather than
 * throwing — the doc is user/agent-authored and may be mid-edit.
 *
 * Rendering is one flat pass: `flattenVisible` (in `tree-model.ts`) walks the
 * doc depth-first once per `nodes` / collapse change and yields the visible
 * rows with their depth and connector geometry, and this component renders
 * that list into a single `<ul>`. A row's position in that list drives the
 * alternating shading, so it stays correct as branches toggle and when one
 * key appears more than once.
 *
 * Selection and collapse are keyed by node key, not by position: in a
 * diamond (one key reachable through two parents) both occurrences select and
 * collapse together. The component never writes `null` to `/ui/<id>/value`:
 * when the selected key disappears from the doc (a refetch, an edit) the
 * stored key stays and no row renders selected, so a transient empty doc does
 * not wipe the selection.
 *
 * Rows scroll inside a fixed-height viewport (`maxHeight`, default `480px`)
 * rather than growing the card unbounded — large docs stay navigable. Set
 * `fill` to grow inside a `fill`-aware parent instead and scroll within
 * whatever height that gives it (ignores `maxHeight`).
 *
 * The doc is untrusted and a shared subtree is expanded under every parent,
 * so the walk is cut at `TREE_MAX_ROWS` rows — a final muted row says so —
 * and a branch deeper than `TREE_MAX_DEPTH` levels is not walked into: that
 * row keeps a collapsed, disabled chevron instead.
 *
 * Keyboard: rows are buttons in the Tab order; ArrowLeft collapses and
 * ArrowRight expands the focused row. The chevrons are click targets only,
 * out of the Tab order. No `role="tree"` or roving tabindex yet.
 */

import { getByPath, type InferComponentProps } from "@json-render/core";
import { useStateStore } from "@json-render/react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { swarmCatalog } from "./catalog";
import {
  type FlattenedTree,
  flattenVisible,
  normalizeNodes,
  TREE_MAX_ROWS,
  type TreeRowModel,
} from "./tree-model";

export type TreeProps = InferComponentProps<typeof swarmCatalog, "Tree">;

const EMPTY_TREE: FlattenedTree = { rows: [], truncated: false };

// Per-nesting-level indent step, in px — also doubles as the connector
// columns' x-spacing (`level * TREE_INDENT`) and as half the row height
// (rows are ~24px tall, so the elbow's vertical midpoint sits at 12px).
const TREE_INDENT = 12;

const FOCUS_RING = "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60";

function TreeRow({
  row,
  index,
  selected,
  onSelect,
  onToggle,
}: {
  row: TreeRowModel;
  /** Position in the flat visible list — drives the alternating shading. */
  index: number;
  selected: string | null;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  const { key, type, depth, isLast, ancestorLines, hasChildren, expanded, capped } = row;
  const isSelected = selected === key;
  const isOddRow = index % 2 === 1;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (!hasChildren || capped) return;
    const collapse = event.key === "ArrowLeft" && expanded;
    const expand = event.key === "ArrowRight" && !expanded;
    if (!collapse && !expand) return;
    event.preventDefault();
    onToggle(key);
  };

  return (
    <li className="relative">
      <div
        className={cn(
          "flex items-center gap-1 px-1 py-0.5 text-sm",
          isSelected
            ? "bg-accent text-accent-foreground"
            : isOddRow
              ? "bg-muted/20 hover:bg-muted"
              : "hover:bg-muted",
        )}
        style={{ paddingLeft: `${depth * TREE_INDENT + 4}px` }}
      >
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            disabled={capped}
            aria-label={expanded ? "Collapse" : "Expand"}
            aria-expanded={expanded}
            title={capped ? "Depth limit reached" : undefined}
            className="flex size-4 shrink-0 items-center justify-center text-muted-foreground disabled:opacity-50"
            onClick={capped ? undefined : () => onToggle(key)}
          >
            {expanded ? (
              <ChevronDown className="size-3.5" />
            ) : (
              <ChevronRight className="size-3.5" />
            )}
          </button>
        ) : (
          <span className="size-4 shrink-0" />
        )}
        <button
          type="button"
          data-slot="tree-row"
          aria-current={isSelected ? "true" : undefined}
          className={cn("min-w-0 flex-1 truncate text-left", FOCUS_RING)}
          onClick={() => onSelect(key)}
          onKeyDown={onKeyDown}
          title={`${key} — ${type}`}
        >
          <span data-slot="tree-row-key" className="font-mono">
            {key}
          </span>
          <span className="text-muted-foreground"> — {type}</span>
        </button>
      </div>
      {depth > 0 ? (
        <>
          {ancestorLines.map((hasLine, i) => {
            const level = i + 1;
            if (!hasLine) return null;
            return (
              <span
                key={level}
                aria-hidden
                className="pointer-events-none absolute top-0 bottom-0 w-px bg-border-subtle"
                style={{ left: `${level * TREE_INDENT}px` }}
              />
            );
          })}
          <span
            aria-hidden
            className="pointer-events-none absolute top-0 w-px bg-border-subtle"
            style={{
              left: `${depth * TREE_INDENT}px`,
              height: isLast ? `${TREE_INDENT}px` : undefined,
              bottom: isLast ? undefined : 0,
            }}
          />
          <span
            aria-hidden
            className="pointer-events-none absolute h-px bg-border-subtle"
            style={{
              left: `${depth * TREE_INDENT}px`,
              top: `${TREE_INDENT}px`,
              width: `${TREE_INDENT}px`,
            }}
          />
        </>
      ) : null}
    </li>
  );
}

export function TreeComponent({ props }: { props: TreeProps }) {
  const { state, set } = useStateStore();
  const path = `/ui/${props.id}/value`;
  const labelId = `ui-${props.id}-label`;
  const stored = getByPath(state, path);
  const selected = typeof stored === "string" ? stored : null;
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());

  const toggle = (key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // The store re-renders this component on every state change; the walk only
  // depends on the doc and the collapsed set.
  const { rows, truncated } = useMemo(() => {
    const normalized = normalizeNodes(props.nodes);
    return normalized
      ? flattenVisible(normalized.root, normalized.elements, collapsed)
      : EMPTY_TREE;
  }, [props.nodes, collapsed]);
  const fill = props.fill === true;

  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", fill && "h-full min-h-0")}>
      {props.label ? <Label id={labelId}>{props.label}</Label> : null}
      <Card className={cn("gap-0 overflow-hidden py-0", fill && "flex min-h-0 flex-1 flex-col")}>
        <CardContent
          className={cn("min-w-0 px-0", fill && "flex min-h-0 flex-1 flex-col overflow-hidden")}
        >
          {rows.length > 0 ? (
            <div
              className={cn("min-w-0 overflow-y-auto", fill && "min-h-0 flex-1")}
              style={fill ? undefined : { maxHeight: props.maxHeight ?? "480px" }}
            >
              <ul className="min-w-0" aria-labelledby={props.label ? labelId : undefined}>
                {rows.map((row, index) => (
                  <TreeRow
                    key={row.id}
                    row={row}
                    index={index}
                    selected={selected}
                    onSelect={(key) => set(path, key)}
                    onToggle={toggle}
                  />
                ))}
                {truncated ? (
                  <li
                    data-slot="tree-truncated"
                    className="flex items-center gap-1 px-1 py-0.5 text-sm text-muted-foreground"
                  >
                    <span className="size-4 shrink-0" aria-hidden />
                    Showing the first {TREE_MAX_ROWS.toLocaleString()} rows
                  </li>
                ) : null}
              </ul>
            </div>
          ) : (
            <p className="px-1 py-2 text-sm text-muted-foreground">No nodes to display.</p>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
