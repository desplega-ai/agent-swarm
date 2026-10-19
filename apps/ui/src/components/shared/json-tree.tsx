import { Check, ChevronDown, ChevronRight, Copy, Link } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { formatJsonPath, jsonValueToClipboard } from "@/lib/json-output";
import { cn } from "@/lib/utils";

interface JsonTreeProps {
  data: unknown;
  defaultExpandDepth?: number;
  maxHeight?: string;
  className?: string;
  /** Hovering a key or item shows buttons that copy its value and its path. */
  copyable?: boolean;
}

export function JsonTree({
  data,
  defaultExpandDepth = 1,
  maxHeight = "300px",
  className,
  copyable = false,
}: JsonTreeProps) {
  if (data === undefined || data === null) return null;

  return (
    <div
      className={cn(
        "rounded-md bg-muted p-3 overflow-auto font-mono text-xs leading-relaxed",
        className,
      )}
      // inline-style: dynamic max-height driven by prop
      style={{ maxHeight }}
    >
      <JsonValue
        value={data}
        depth={0}
        defaultExpandDepth={defaultExpandDepth}
        copyable={copyable}
        path={[]}
      />
    </div>
  );
}

// --- Internal components ---

type JsonPath = ReadonlyArray<string | number>;

interface NodeProps {
  depth: number;
  defaultExpandDepth: number;
  copyable: boolean;
  path: JsonPath;
}

function JsonValue({ value, suffix, ...node }: NodeProps & { value: unknown; suffix?: ReactNode }) {
  if (Array.isArray(value)) {
    return <JsonArray items={value} suffix={suffix} {...node} />;
  }
  if (value !== null && typeof value === "object") {
    return <JsonObject obj={value as Record<string, unknown>} suffix={suffix} {...node} />;
  }
  return (
    <>
      <JsonScalar value={value} />
      {suffix}
    </>
  );
}

function JsonScalar({ value }: { value: unknown }) {
  if (value === null) {
    return <span className="text-muted-foreground italic">null</span>;
  }
  if (value === undefined) {
    return <span className="text-muted-foreground italic">undefined</span>;
  }

  const type = typeof value;

  if (type === "string") {
    return <span className="text-status-success-strong">&quot;{String(value)}&quot;</span>;
  }
  if (type === "number") {
    return <span className="text-status-active-strong">{String(value)}</span>;
  }
  if (type === "boolean") {
    return <span className="text-status-info-strong">{String(value)}</span>;
  }

  // Fallback for anything else
  return <span className="text-muted-foreground">{String(value)}</span>;
}

function JsonObject({
  obj,
  depth,
  defaultExpandDepth,
  copyable,
  path,
  suffix,
}: NodeProps & { suffix?: ReactNode; obj: Record<string, unknown> }) {
  const entries = Object.entries(obj);
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (entries.length === 0) {
    return (
      <>
        <span className="text-muted-foreground">{"{}"}</span>
        {suffix}
      </>
    );
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
      {!expanded && suffix}
      {expanded && (
        <>
          {entries.map(([key, val], i) => (
            <JsonRow key={key} copyable={copyable} value={val} path={[...path, key]}>
              <span className="text-muted-foreground">{key}</span>
              <span className="text-muted-foreground">: </span>
              <JsonValue
                value={val}
                depth={depth + 1}
                defaultExpandDepth={defaultExpandDepth}
                copyable={copyable}
                path={[...path, key]}
                suffix={i < entries.length - 1 && <span className="text-muted-foreground">,</span>}
              />
            </JsonRow>
          ))}
          <div>
            <span className="text-muted-foreground">{"}"}</span>
            {suffix}
          </div>
        </>
      )}
    </span>
  );
}

function JsonArray({
  items,
  depth,
  defaultExpandDepth,
  copyable,
  path,
  suffix,
}: NodeProps & { suffix?: ReactNode; items: unknown[] }) {
  const [expanded, setExpanded] = useState(depth < defaultExpandDepth);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  if (items.length === 0) {
    return (
      <>
        <span className="text-muted-foreground">{"[]"}</span>
        {suffix}
      </>
    );
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
      {!expanded && suffix}
      {expanded && (
        <>
          {items.map((item, i) => (
            <JsonRow key={i} copyable={copyable} value={item} path={[...path, i]}>
              <JsonValue
                value={item}
                depth={depth + 1}
                defaultExpandDepth={defaultExpandDepth}
                copyable={copyable}
                path={[...path, i]}
                suffix={i < items.length - 1 && <span className="text-muted-foreground">,</span>}
              />
            </JsonRow>
          ))}
          <div>
            <span className="text-muted-foreground">{"]"}</span>
            {suffix}
          </div>
        </>
      )}
    </span>
  );
}

/**
 * One key or array item. With `copyable`, hovering the row (but not a nested
 * row inside it) reveals its copy buttons at the right edge.
 */
function JsonRow({
  copyable,
  value,
  path,
  children,
}: {
  copyable: boolean;
  value: unknown;
  path: JsonPath;
  children: ReactNode;
}) {
  return (
    <div
      className={cn(
        "pl-4",
        copyable &&
          "json-row relative [&:hover:not(:has(.json-row:hover))>.json-actions]:opacity-100",
      )}
    >
      {children}
      {copyable && <NodeCopyActions value={value} path={path} />}
    </div>
  );
}

function NodeCopyActions({ value, path }: { value: unknown; path: JsonPath }) {
  const { copiedKey, copy } = useCopyToClipboard<"value" | "path">();
  return (
    <span className="json-actions absolute top-0 right-0 flex items-center gap-0.5 rounded bg-muted pl-1 opacity-0 focus-within:opacity-100 transition-opacity">
      <CopyButton
        label="Copy value"
        copied={copiedKey === "value"}
        onClick={() => copy(jsonValueToClipboard(value), "value")}
        icon={<Copy className="h-3 w-3" />}
      />
      <CopyButton
        label={`Copy path ${formatJsonPath(path)}`}
        copied={copiedKey === "path"}
        onClick={() => copy(formatJsonPath(path), "path")}
        icon={<Link className="h-3 w-3" />}
      />
    </span>
  );
}

function CopyButton({
  label,
  copied,
  onClick,
  icon,
}: {
  label: string;
  copied: boolean;
  onClick: () => void;
  icon: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
      className="inline-flex items-center justify-center h-4 w-4 rounded text-muted-foreground hover:text-foreground hover:bg-muted-foreground/20"
    >
      {copied ? <Check className="h-3 w-3" /> : icon}
    </button>
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
      aria-label={expanded ? "Collapse" : "Expand"}
      aria-expanded={expanded}
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
