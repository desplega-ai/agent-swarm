import type { ReactNode } from "react";
import "../pages/analytics.css";

/** Segmented control (pill group); the look lives in analytics.css (`.an-seg`). */
export function Seg<K extends string>(props: {
  options: readonly { key: K; label: string; title?: string }[];
  value: K;
  onChange: (key: K) => void;
}): ReactNode {
  return (
    <div className="an-seg">
      {props.options.map((o) => (
        <button
          key={o.key}
          type="button"
          title={o.title}
          aria-pressed={o.key === props.value}
          className={o.key === props.value ? "active" : undefined}
          onClick={() => props.onChange(o.key)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
