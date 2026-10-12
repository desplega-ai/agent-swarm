/**
 * Copy and visibility rules for the fleet benchmark card. Pure.
 *
 * The API places this swarm in the fleet percentiles (`GET /api/fleet-benchmark`);
 * this file only turns that into words and decides what the card shows.
 */
import type { FleetBand, FleetBenchmarkResponse, FleetComparison } from "@/api/types";

const BAND_LABELS: Record<FleetBand, string> = {
  top_10: "top 10%",
  top_25: "top 25%",
  above_median: "above the median",
  below_median: "below the median",
  bottom_25: "bottom 25%",
};

const PEER_LABELS: Record<FleetComparison["peers"], string> = {
  "1": "single-agent swarms",
  "2-5": "swarms with 2-5 agents",
  "6+": "swarms with 6+ agents",
  all: "active swarms",
};

export function formatFleetValue(comparison: Pick<FleetComparison, "key" | "value">): string {
  if (comparison.key === "taskSuccessRate") return `${formatPercent(comparison.value)} success`;
  return `${formatRate(comparison.value)} tasks/week`;
}

export function formatFleetMedian(comparison: Pick<FleetComparison, "key" | "p50">): string {
  return comparison.key === "taskSuccessRate"
    ? formatPercent(comparison.p50)
    : formatRate(comparison.p50);
}

/** "top 25% of swarms with 2-5 agents" */
export function fleetPlacement(comparison: Pick<FleetComparison, "band" | "peers">): string {
  return `${BAND_LABELS[comparison.band]} of ${PEER_LABELS[comparison.peers]}`;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

function formatRate(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(value);
}

export type FleetCardMode = "benchmark" | "progress" | "perk" | null;

/**
 * What the card shows.
 * - `benchmark`: the comparison is ready.
 * - `progress`: telemetry on and named, but under 10 finished tasks in 30 days.
 * - `perk`: no benchmark to show, but a workflow has completed: the Slack
 *   Connect perk alone, until the user submits or dismisses the invite.
 * Telemetry off or no org name shows nothing here: the telemetry banner and
 * the org-name nudge already ask for those, and say what it unlocks.
 */
export function fleetCardMode(input: {
  benchmark: FleetBenchmarkResponse | undefined;
  benchmarkDismissed: boolean;
  inviteOpen: boolean;
  workflowRunsCompleted: number;
}): FleetCardMode {
  const state = input.benchmark?.state;
  if (!input.benchmarkDismissed && state === "ready") return "benchmark";
  if (!input.benchmarkDismissed && state === "not_enough_tasks") return "progress";
  if (input.inviteOpen && input.workflowRunsCompleted > 0) return "perk";
  return null;
}
