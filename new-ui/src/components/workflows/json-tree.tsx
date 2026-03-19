import { ChevronDown, ChevronRight } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { cn } from "@/lib/utils";

interface JsonTreeProps {
  data: unknown;
  defaultExpandDepth?: number;
  maxHeight?: string;
  className?: string;
}

export function JsonTree({
  data,
  defaultExpandDepth = 1,
  maxHeight = "300px",
  className,
}: JsonTreeProps) {
  if (data === undefined || data === null) return null;

  return (
    <div
      className={cn(
        "rounded-md bg-muted p-3 overflow-auto font-mono text-xs leading-relaxed",
        className,
      )}
      style={{ maxHeight }}
    >
      <JsonValue value={data} depth={0} defaultExpandDepth={defaultExpandDepth} />
    </div>
  );
}

// --- Internal components ---

interface JsonValueProps {
  value: unknown;
  depth: number;
  defaultExpandDepth: number;
}

function JsonValue({ value, depth, defaultExpandDepth }: JsonValueProps) {
  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (value === undefined) {
    return <span className="text-muted-foreground italic">undefined</span>;
  }

  const type = typeof value;

  if (type === "string") {
    return (
      <span className="text-emerald-600 dark:text-emerald-400">&quot;{String(value)}&quot;</span>
    );
  }
  if (type === "number") {
    return <span className="text-amber-600 dark:text-amber-400">{String(value)}</span>;
  }
  if (type === "boolean") {
    return <span className="text-sky-600 dark:text-sky-400">{String(value)}</span>;
  }

  if (Array.isArray(value)) {
    return <JsonArray items={value} depth={depth} defaultExpandDepth={defaultExpandDepth} />;
  }
  if (type === "object") {
    return (
      <JsonObject
        obj={value as Record<string, unknown>}
        depth={depth}
        defaultExpandDepth={defaultExpandDepth}
      />
    );
  }

  // Fallback for anything else
  return <span className="text-muted-foreground">{String(value)}</span>;
}

interface JsonObjectProps {
  obj: Record<string, unknown>;
  depth: number;
  defaultExpandDepth: number;
}

function JsonObject({ obj, depth, defaultExpandDepth }: JsonObjectProps) {
  const entries = Object.entries(obj);
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (entries.length === 0) {
    return <span className="text-muted-foreground">{"{}"}</span>;
  }

  return (
    <span>
      <CollapsibleToggle expanded={expanded} onClick={toggle} />
      <span className="text-muted-foreground">{"{"}</span>
      {!expanded && (
        <span className="text-muted-foreground cursor-pointer" onClick={toggle}>
          {" "}
          {entries.length} {entries.length === 1 ? "key" : "keys"}{" "}
        </span>
      )}
      {!expanded && <span className="text-muted-foreground">{"}"}</span>}
      {expanded && (
        <>
          {entries.map(([key, val], i) => (
            <div key={key} style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
              <span className="text-muted-foreground">{key}</span>
              <span className="text-muted-foreground">: </span>
              <JsonValue value={val} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
              {i < entries.length - 1 && <span className="text-muted-foreground">,</span>}
            </div>
          ))}
          <div style={{ paddingLeft: `${depth * 16}px` }}>
            <span className="text-muted-foreground">{"}"}</span>
          </div>
        </>
      )}
    </span>
  );
}

interface JsonArrayProps {
  items: unknown[];
  depth: number;
  defaultExpandDepth: number;
}

function JsonArray({ items, depth, defaultExpandDepth }: JsonArrayProps) {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (items.length === 0) {
    return <span className="text-muted-foreground">{"[]"}</span>;
  }

  return (
    <span>
      <CollapsibleToggle expanded={expanded} onClick={toggle} />
      <span className="text-muted-foreground">{"["}</span>
      {!expanded && (
        <span className="text-muted-foreground cursor-pointer" onClick={toggle}>
          {" "}
          {items.length} {items.length === 1 ? "item" : "items"}{" "}
        </span>
      )}
      {!expanded && <span className="text-muted-foreground">{"]"}</span>}
      {expanded && (
        <>
          {items.map((item, i) => (
            <div key={i} style={{ paddingLeft: `${(depth + 1) * 16}px` }}>
              <JsonValue value={item} depth={depth + 1} defaultExpandDepth={defaultExpandDepth} />
              {i < items.length - 1 && <span className="text-muted-foreground">,</span>}
            </div>
          ))}
          <div style={{ paddingLeft: `${depth * 16}px` }}>
            <span className="text-muted-foreground">{"]"}</span>
          </div>
        </>
      )}
    </span>
  );
}

function CollapsibleToggle({
  expanded,
  onClick,
}: {
  expanded: boolean;
  onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex items-center justify-center h-4 w-4 rounded hover:bg-muted-foreground/20 align-middle mr-0.5"
    >
      {expanded ? (
        <ChevronDown className="h-3 w-3 text-muted-foreground" />
      ) : (
        <ChevronRight className="h-3 w-3 text-muted-foreground" />
      )}
    </button>
  );
}
