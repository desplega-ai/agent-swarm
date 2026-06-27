import type { ReactNode } from "react";
import { fmtCost, fmtScore } from "./format.ts";
import { Spinner } from "./Spinner.tsx";
import { InfoTip, Tooltip } from "./Tooltip.tsx";

export interface StatusGlyphInfo {
  /** Unicode glyph; empty string for live statuses (rendered as an animated Spinner). */
  glyph: string;
  tone: "green" | "red" | "accent" | "dim" | "neutral";
  /** Capitalized label for tooltips/aria, e.g. "Passed". */
  label: string;
  /** running/judging/live → animated rendering. */
  live: boolean;
}

const GLYPHS: Record<string, StatusGlyphInfo> = {
  passed: { glyph: "✓", tone: "green", label: "Passed", live: false },
  pass: { glyph: "✓", tone: "green", label: "Pass", live: false },
  done: { glyph: "✓", tone: "green", label: "Done", live: false },
  failed: { glyph: "✗", tone: "red", label: "Failed", live: false },
  fail: { glyph: "✗", tone: "red", label: "Fail", live: false },
  error: { glyph: "⚠", tone: "red", label: "Error", live: false },
  running: { glyph: "", tone: "accent", label: "Running", live: true },
  live: { glyph: "", tone: "accent", label: "Live", live: true },
  judging: { glyph: "◔", tone: "accent", label: "Judging", live: true },
  pending: { glyph: "○", tone: "dim", label: "Pending", live: false },
  cancelled: { glyph: "⊘", tone: "dim", label: "Cancelled", live: false },
};

export function statusGlyphInfo(status: string): StatusGlyphInfo {
  const s = status.toLowerCase();
  return (
    GLYPHS[s] ?? {
      glyph: "•",
      tone: "neutral",
      label: s.length > 0 ? s[0].toUpperCase() + s.slice(1) : "Unknown",
      live: false,
    }
  );
}

function GlyphSpan(props: { info: StatusGlyphInfo }): ReactNode {
  const { info } = props;
  if (info.live && info.glyph === "") {
    return (
      <span className={`status-glyph tone-${info.tone}`} role="img" aria-label={info.label}>
        <Spinner />
      </span>
    );
  }
  return (
    <span
      className={`status-glyph tone-${info.tone}${info.live ? " pulse" : ""}`}
      role="img"
      aria-label={info.label}
    >
      {info.glyph}
    </span>
  );
}

/**
 * Status as a unicode glyph (✓ ✗ ⚠ ○ ⊘ ◔ / braille spinner) with hover info — no text chips.
 *
 * SINGLE-ANIMATION RULE (v4 item 7): a status indicator and a "live" affordance
 * MUST be the same element. Pages must NEVER render a separate <Spinner> next to
 * a StatusBadge — pass `activeLabel` instead and this renders exactly ONE
 * animated spinner with the label as static text.
 */
export function StatusBadge(props: {
  status: string;
  tip?: string;
  /** Executor-live label ("Live" / "Executing"). Renders ONE spinner + static text. */
  activeLabel?: string;
}): ReactNode {
  const info = statusGlyphInfo(props.status);
  if (props.activeLabel !== undefined) {
    const tipText = [props.tip ?? info.label, props.activeLabel].filter(Boolean).join(" · ");
    return (
      <Tooltip text={tipText}>
        <span className="status-live" role="img" aria-label={tipText}>
          <Spinner />
          <span className="status-live-label">{props.activeLabel}</span>
        </span>
      </Tooltip>
    );
  }
  return (
    <Tooltip text={props.tip ?? info.label}>
      <GlyphSpan info={info} />
    </Tooltip>
  );
}

/** Joined status + score: one compact token, e.g. "✓ 1.00" / "✗ 0.40" / spinner while live. */
export function StatusScore(props: {
  status: string;
  score: number | null;
  /** Extra tooltip line(s) appended below the default "Label · Score n". */
  tip?: string;
}): ReactNode {
  const info = statusGlyphInfo(props.status);
  const scoreText = props.score !== null ? fmtScore(props.score) : null;
  const tipText = [
    scoreText !== null ? `${info.label} · Score ${scoreText}` : info.label,
    props.tip,
  ]
    .filter(Boolean)
    .join("\n");
  return (
    <Tooltip text={tipText}>
      <span className={`status-score tone-${info.tone}`}>
        <GlyphSpan info={info} />
        {scoreText !== null ? <span className="status-score-num">{scoreText}</span> : null}
      </span>
    </Tooltip>
  );
}

export function CostBadge(props: { costUsd: number | null; source: string | null }): ReactNode {
  const { costUsd, source } = props;
  if (costUsd === null) {
    const tip =
      source === "unpriced"
        ? "Unpriced — no cost rows and token recompute found nothing"
        : "Not measured";
    return (
      <span className="cost-badge dim">
        — <InfoTip text={tip} />
      </span>
    );
  }
  if (source === "recomputed") {
    return (
      <span className="cost-badge">
        ~{fmtCost(costUsd)} <InfoTip text="Recomputed from tokens × models.dev pricing" />
      </span>
    );
  }
  return <span className="cost-badge">{fmtCost(costUsd)}</span>;
}
