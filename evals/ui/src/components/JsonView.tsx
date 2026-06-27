import { type ReactNode, useMemo, useState } from "react";

const STRING_CLIP = 600;

/** Collapsible, syntax-tinted JSON pretty-print (leaf colors via .jv-* CSS vars). */
export function JsonView(props: {
  value: unknown;
  collapseDepth?: number; // depth at which objects/arrays start collapsed; default 2
  label?: string; // optional root label
}): ReactNode {
  return (
    <div className="jv">
      {props.label ? <span className="jv-label">{props.label}</span> : null}
      <Node value={props.value} depth={0} collapseDepth={props.collapseDepth ?? 2} />
    </div>
  );
}

function Node(props: { value: unknown; depth: number; collapseDepth: number }): ReactNode {
  const { value, depth, collapseDepth } = props;
  if (value === null || value === undefined) return <span className="jv-null">null</span>;
  if (typeof value === "boolean") return <span className="jv-bool">{String(value)}</span>;
  if (typeof value === "number") return <span className="jv-num">{String(value)}</span>;
  if (typeof value === "string") {
    return <StringLeaf value={value} depth={depth} collapseDepth={collapseDepth} />;
  }
  if (Array.isArray(value) || typeof value === "object") {
    return (
      <Composite
        value={value as Record<string, unknown> | unknown[]}
        depth={depth}
        collapseDepth={collapseDepth}
      />
    );
  }
  return <span className="jv-str">{String(value)}</span>;
}

function Composite(props: {
  value: Record<string, unknown> | unknown[];
  depth: number;
  collapseDepth: number;
}): ReactNode {
  const { value, depth, collapseDepth } = props;
  const isArr = Array.isArray(value);
  const entries = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v] as const)
    : Object.entries(value);
  const [open, setOpen] = useState(depth < collapseDepth);
  if (entries.length === 0) return <span className="jv-punct">{isArr ? "[]" : "{}"}</span>;
  if (!open) {
    const summary = isArr
      ? `[…] ${entries.length}`
      : `{…} ${entries.length} ${entries.length === 1 ? "key" : "keys"}`;
    return (
      <button type="button" className="jv-toggle" onClick={() => setOpen(true)}>
        ▸ {summary}
      </button>
    );
  }
  return (
    <span className="jv-composite">
      <button type="button" className="jv-toggle" onClick={() => setOpen(false)}>
        ▾ {isArr ? "[" : "{"}
      </button>
      <div className="jv-children">
        {entries.map(([k, v]) => (
          <div className="jv-row" key={k}>
            {isArr ? <span className="jv-index">{k}</span> : <span className="jv-key">{k}</span>}
            <span className="jv-punct">: </span>
            <Node value={v} depth={depth + 1} collapseDepth={collapseDepth} />
          </div>
        ))}
      </div>
      <span className="jv-punct">{isArr ? "]" : "}"}</span>
    </span>
  );
}

function tryParseJson(s: string): unknown | undefined {
  const t = s.trim();
  const looksJson =
    (t.startsWith("{") && t.endsWith("}")) || (t.startsWith("[") && t.endsWith("]"));
  if (!looksJson) return undefined;
  try {
    return JSON.parse(t) as unknown;
  } catch {
    return undefined;
  }
}

function StringLeaf(props: { value: string; depth: number; collapseDepth: number }): ReactNode {
  const { value, depth, collapseDepth } = props;
  const [parsed, setParsed] = useState(false);
  const [full, setFull] = useState(false);
  const inner = useMemo(() => tryParseJson(value), [value]);

  if (parsed && inner !== undefined) {
    return (
      <span className="jv-parsed">
        <button type="button" className="jv-toggle" onClick={() => setParsed(false)}>
          Raw
        </button>{" "}
        <Node value={inner} depth={depth} collapseDepth={collapseDepth} />
      </span>
    );
  }

  const clipped = !full && value.length > STRING_CLIP;
  const shown = clipped ? value.slice(0, STRING_CLIP) : value;
  return (
    <span className="jv-str">
      "{shown}
      {clipped ? "…" : ""}"
      {clipped ? (
        <button type="button" className="jv-toggle" onClick={() => setFull(true)}>
          Show all ({value.length})
        </button>
      ) : null}
      {inner !== undefined ? (
        <button type="button" className="jv-toggle" onClick={() => setParsed(true)}>
          Parse
        </button>
      ) : null}
    </span>
  );
}
