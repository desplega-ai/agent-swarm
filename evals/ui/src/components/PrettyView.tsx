import { type ReactNode, useState } from "react";
import { fmtAgo, fmtCost, fmtDate, fmtDuration, fmtTokens, humanizeKey } from "./format.ts";
import { JsonView } from "./JsonView.tsx";

const LONG_STRING = 280;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const HTTP_URL = /^https?:\/\/\S+$/;

export interface PrettyCtx {
  /** Dot-path from the root, e.g. "outcome.llmJudge.rubric". */
  path: string;
  key: string;
}

export interface PrettyViewProps {
  value: unknown;
  /** Dot-path OR bare-key → display-label override. */
  labels?: Record<string, string>;
  /** Dot-path OR bare-key → custom value renderer. */
  renderers?: Record<string, (value: unknown, ctx: PrettyCtx) => ReactNode>;
  /** Dot-paths or bare keys to omit entirely. */
  hide?: string[];
  /** Start in raw-JSON mode (default false — pretty first). */
  defaultRaw?: boolean;
  /** Optional label passed to JsonView in raw mode. */
  rawLabel?: string;
}

/**
 * Humanized key/value rendering of arbitrary JSON-ish data — sections and
 * definition rows instead of JSON syntax — with a Raw JSON toggle (item 14).
 */
export function PrettyView(props: PrettyViewProps): ReactNode {
  const [raw, setRaw] = useState(props.defaultRaw ?? false);
  return (
    <div className="pv">
      <div className="pv-bar">
        <button
          type="button"
          className="pv-toggle"
          onClick={() => setRaw((r) => !r)}
          title={raw ? "Switch to the humanized view" : "Switch to raw JSON"}
        >
          {raw ? "≡ Pretty" : "{ } Raw"}
        </button>
      </div>
      {raw ? (
        <JsonView value={props.value} collapseDepth={2} label={props.rawLabel} />
      ) : (
        <PrettyNode value={props.value} path="" keyName="" props={props} depth={0} />
      )}
    </div>
  );
}

function lookup<T>(map: Record<string, T> | undefined, ctx: PrettyCtx): T | undefined {
  if (!map) return undefined;
  return map[ctx.path] ?? map[ctx.key];
}

function isHidden(props: PrettyViewProps, ctx: PrettyCtx): boolean {
  return props.hide?.includes(ctx.path) === true || props.hide?.includes(ctx.key) === true;
}

function labelFor(props: PrettyViewProps, ctx: PrettyCtx): string {
  return lookup(props.labels, ctx) ?? humanizeKey(ctx.key);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function PrettyNode(args: {
  value: unknown;
  path: string;
  keyName: string;
  props: PrettyViewProps;
  depth: number;
}): ReactNode {
  const { value, path, keyName, props, depth } = args;
  const ctx: PrettyCtx = { path, key: keyName };
  const custom = lookup(props.renderers, ctx);
  if (custom && path !== "") return custom(value, ctx);

  if (isPlainObject(value)) {
    const entries = Object.entries(value).filter(
      ([k]) => !isHidden(props, { path: path === "" ? k : `${path}.${k}`, key: k }),
    );
    if (entries.length === 0) return <span className="dim">Empty</span>;
    return (
      <div className="pv-rows">
        {entries.map(([k, v]) => {
          const childPath = path === "" ? k : `${path}.${k}`;
          const childCtx: PrettyCtx = { path: childPath, key: k };
          const isSection =
            (isPlainObject(v) && Object.keys(v).length > 0) ||
            (Array.isArray(v) && v.some(isPlainObject));
          if (isSection && !lookup(props.renderers, childCtx)) {
            return (
              <div className="pv-section" key={k}>
                <div className="pv-section-title">{labelFor(props, childCtx)}</div>
                <div className="pv-section-body">
                  <PrettyNode
                    value={v}
                    path={childPath}
                    keyName={k}
                    props={props}
                    depth={depth + 1}
                  />
                </div>
              </div>
            );
          }
          return (
            <div className="pv-row" key={k}>
              <div className="pv-key">{labelFor(props, childCtx)}</div>
              <div className="pv-val">
                <PrettyNode
                  value={v}
                  path={childPath}
                  keyName={k}
                  props={props}
                  depth={depth + 1}
                />
              </div>
            </div>
          );
        })}
      </div>
    );
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return <span className="dim">Empty</span>;
    if (value.some(isPlainObject)) {
      return (
        <div className="pv-rows">
          {value.map((item, i) => (
            <div className="pv-section" key={`${path}-${String(i)}`}>
              <div className="pv-section-title dim">#{i}</div>
              <div className="pv-section-body">
                <PrettyNode
                  value={item}
                  path={`${path}.${i}`}
                  keyName={keyName}
                  props={props}
                  depth={depth + 1}
                />
              </div>
            </div>
          ))}
        </div>
      );
    }
    return (
      <span className="pv-chips">
        {value.map((item, i) => (
          <span className="chip" key={`${String(item)}-${String(i)}`}>
            {String(item)}
          </span>
        ))}
      </span>
    );
  }

  return <Leaf value={value} keyName={keyName} />;
}

function Leaf(props: { value: unknown; keyName: string }): ReactNode {
  const { value, keyName } = props;
  if (value === null || value === undefined) return <span className="dim">—</span>;
  if (typeof value === "boolean") {
    return value ? (
      <span className="tone-green" role="img" aria-label="Yes" title="Yes">
        ✓
      </span>
    ) : (
      <span className="tone-red" role="img" aria-label="No" title="No">
        ✗
      </span>
    );
  }
  if (typeof value === "number") {
    if (/ms$/i.test(keyName) || /millis/i.test(keyName)) return fmtDuration(value);
    if (/usd|cost|price/i.test(keyName)) return fmtCost(value);
    if (/tokens?$/i.test(keyName)) return fmtTokens(value);
    return value.toLocaleString();
  }
  if (typeof value === "string") {
    if (value.length === 0) return <span className="dim">—</span>;
    if (ISO_DATE.test(value)) {
      return (
        <span title={value}>
          {fmtDate(value)} <span className="dim">· {fmtAgo(value)}</span>
        </span>
      );
    }
    if (HTTP_URL.test(value)) {
      return (
        <a className="entity-link" href={value} target="_blank" rel="noreferrer">
          {value}
        </a>
      );
    }
    if (value.length > LONG_STRING) return <LongString text={value} />;
    return <span className="pv-str">{value}</span>;
  }
  return <span className="pv-str">{String(value)}</span>;
}

function LongString(props: { text: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <span className="pv-long">
      <button type="button" className="pv-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} {open ? "Hide" : "Show"} ({props.text.length.toLocaleString()} chars)
      </button>
      {open ? <pre className="pv-pre">{props.text}</pre> : null}
    </span>
  );
}
