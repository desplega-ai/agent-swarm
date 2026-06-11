import type { ReactNode } from "react";
import { fmtCost } from "./format.ts";
import { PulseDot } from "./Spinner.tsx";
import { InfoTip } from "./Tooltip.tsx";

const GREEN = new Set(["passed", "done", "pass"]);
const RED = new Set(["failed", "fail", "error"]);
const LIVE = new Set(["running", "judging", "live"]);
const DIM = new Set(["pending", "cancelled"]);

export function StatusBadge(props: { status: string }): ReactNode {
  const s = props.status.toLowerCase();
  const tone = GREEN.has(s)
    ? "badge-green"
    : RED.has(s)
      ? "badge-red"
      : LIVE.has(s)
        ? "badge-accent"
        : DIM.has(s)
          ? "badge-dim"
          : "badge-neutral";
  return (
    <span className={`badge ${tone}`}>
      {LIVE.has(s) ? <PulseDot /> : null}
      {s}
    </span>
  );
}

export function CostBadge(props: { costUsd: number | null; source: string | null }): ReactNode {
  const { costUsd, source } = props;
  if (costUsd === null) {
    const tip =
      source === "unpriced"
        ? "unpriced — no cost rows and token recompute found nothing"
        : "not measured";
    return (
      <span className="cost-badge dim">
        — <InfoTip text={tip} />
      </span>
    );
  }
  if (source === "recomputed") {
    return (
      <span className="cost-badge">
        ~{fmtCost(costUsd)} <InfoTip text="recomputed from tokens × models.dev pricing" />
      </span>
    );
  }
  return <span className="cost-badge">{fmtCost(costUsd)}</span>;
}
