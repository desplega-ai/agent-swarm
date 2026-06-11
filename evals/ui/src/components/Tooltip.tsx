import type { ReactNode } from "react";

/** Pure-CSS hover/focus tooltip (styles in styles.css via the data-tip pseudo-element). */
export function Tooltip(props: { text: string; children: ReactNode }): ReactNode {
  return (
    <span className="tooltip" data-tip={props.text}>
      {props.children}
    </span>
  );
}

/** Lowkey ⓘ glyph + Tooltip. */
export function InfoTip(props: { text: string }): ReactNode {
  return (
    <Tooltip text={props.text}>
      <span className="info-tip" role="img" aria-label={props.text}>
        ⓘ
      </span>
    </Tooltip>
  );
}
