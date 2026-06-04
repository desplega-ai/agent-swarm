import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useState } from "react";
import { cn } from "@/lib/utils";

const STRING_INLINE_MAX = 140;
const STRING_PREVIEW = 320;
const INDENT = 14;

interface JsonViewProps {
  data: unknown;
  maxHeight?: string;
  defaultExpandDepth?: number;
  className?: string;
}

/**
 * Readable, brace-free tree view of arbitrary JSON. Object keys are teal,
 * values type-colored; nested objects/arrays collapse behind a chevron with a
 * "N keys" hint. Long/multi-line strings preview with a `+N chars` toggle.
 */
export function JsonView({
  data,
  maxHeight = "300px",
  defaultExpandDepth = 1,
  className,
}: JsonViewProps) {
  return (
    <div
      className={cn(
        "overflow-auto rounded-md bg-muted p-3 font-mono text-xs leading-relaxed",
        className,
      )}
      // inline-style: dynamic max-height driven by prop
      style={{ maxHeight }}
    >
      <Node
        nodeKey={null}
        fromArray={false}
        value={data}
        depth={0}
        expandDepth={defaultExpandDepth}
      />
    </div>
  );
}

function StringValue({ value }: { value: string }) {
  const [open, setOpen] = useState(false);
  const multiline = value.includes("\n");

  if (!multiline && value.length <= STRING_INLINE_MAX) {
    return <span className="text-status-success-strong">{value}</span>;
  }

  const overflow = value.length - STRING_PREVIEW;
  const shown = open || overflow <= 0 ? value : value.slice(0, STRING_PREVIEW);
  return (
    <span className="align-top">
      <span className="whitespace-pre-wrap text-status-success-strong">{shown}</span>
      {overflow > 0 && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-1 rounded-sm px-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted-foreground/15 hover:text-foreground"
        >
          {open ? "show less" : `+${overflow} chars`}
        </button>
      )}
    </span>
  );
}

function Primitive({ value }: { value: unknown }) {
  if (value === null) return <span className="text-muted-foreground italic">null</span>;
  if (value === undefined) return <span className="text-muted-foreground italic">—</span>;
  if (typeof value === "string") return <StringValue value={value} />;
  if (typeof value === "number")
    return <span className="text-status-active-strong">{String(value)}</span>;
  if (typeof value === "boolean")
    return <span className="text-status-info-strong">{String(value)}</span>;
  return <span className="text-foreground/80">{String(value)}</span>;
}

function KeyLabel({ nodeKey, fromArray }: { nodeKey: string | number; fromArray: boolean }) {
  if (fromArray) {
    return <span className="mr-2 select-none text-muted-foreground/50">{nodeKey}</span>;
  }
  return <span className="text-action-notify">{nodeKey}</span>;
}

function Node({
  nodeKey,
  fromArray,
  value,
  depth,
  expandDepth,
}: {
  nodeKey: string | number | null;
  fromArray: boolean;
  value: unknown;
  depth: number;
  expandDepth: number;
}) {
  const isRoot = nodeKey === null;
  const keyNode = isRoot ? null : <KeyLabel nodeKey={nodeKey} fromArray={fromArray} />;
  const isContainer = value !== null && typeof value === "object";

  if (!isContainer) {
    return (
      <div className="break-words" style={{ paddingLeft: `${depth * INDENT}px` }}>
        {keyNode}
        {keyNode && !fromArray && <span className="text-muted-foreground">: </span>}
        <Primitive value={value} />
      </div>
    );
  }

  const isArray = Array.isArray(value);
  const entries: Array<[string | number, unknown]> = isArray
    ? (value as unknown[]).map((v, i) => [i, v])
    : Object.entries(value as Record<string, unknown>);
  const childDepth = isRoot ? depth : depth + 1;
  const children = entries.map(([k, v]) => (
    <Node
      key={String(k)}
      nodeKey={k}
      fromArray={isArray}
      value={v}
      depth={childDepth}
      expandDepth={expandDepth}
    />
  ));

  if (isRoot) {
    if (entries.length === 0) {
      return (
        <span className="text-muted-foreground italic">{isArray ? "empty list" : "empty"}</span>
      );
    }
    return <>{children}</>;
  }

  return (
    <Branch
      keyNode={keyNode}
      count={entries.length}
      isArray={isArray}
      depth={depth}
      defaultOpen={depth < expandDepth}
    >
      {children}
    </Branch>
  );
}

function Branch({
  keyNode,
  count,
  isArray,
  depth,
  defaultOpen,
  children,
}: {
  keyNode: ReactNode;
  count: number;
  isArray: boolean;
  depth: number;
  defaultOpen: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const empty = count === 0;
  const summary = empty
    ? isArray
      ? "empty list"
      : "empty"
    : `${count} ${isArray ? (count === 1 ? "item" : "items") : count === 1 ? "key" : "keys"}`;

  return (
    <>
      <div style={{ paddingLeft: `${depth * INDENT}px` }}>
        <button
          type="button"
          onClick={() => !empty && setOpen((o) => !o)}
          className="inline-flex items-center gap-1 text-left align-top"
        >
          {empty ? (
            <span className="inline-block w-3" />
          ) : open ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {keyNode}
          <span className="text-[10px] text-muted-foreground/60">{summary}</span>
        </button>
      </div>
      {open && !empty && children}
    </>
  );
}
