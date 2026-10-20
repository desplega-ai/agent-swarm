/**
 * Copy and visibility rules for the fleet benchmark card. Pure.
 *
 * The API places this swarm in the fleet percentiles (`GET /api/fleet-benchmark`);
 * this file only turns that into words and decides what the card shows.
 */
import type {
  FleetBand,
  FleetBenchmarkResponse,
  FleetComparison,
  FleetPeerGroup,
} from "@/api/types";
import { optionLabel, TEAM_SIZES, USE_CASES } from "./company-profile";

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

/** "swarms with 2-5 agents" */
export function fleetPeersLabel(peers: FleetComparison["peers"]): string {
  return PEER_LABELS[peers];
}

/** The number alone: "42" tasks per week, "93%" success. */
export function formatFleetNumber(key: FleetComparison["key"], value: number): string {
  return key === "taskSuccessRate" ? formatPercent(value) : formatRate(value);
}

export function formatFleetValue(comparison: Pick<FleetComparison, "key" | "value">): string {
  const number = formatFleetNumber(comparison.key, comparison.value);
  return comparison.key === "taskSuccessRate" ? `${number} success` : `${number} tasks/week`;
}

export function formatFleetMedian(comparison: Pick<FleetComparison, "key" | "p50">): string {
  return formatFleetNumber(comparison.key, comparison.p50);
}

/** "top 25% of swarms with 2-5 agents" */
export function fleetPlacement(comparison: Pick<FleetComparison, "band" | "peers">): string {
  return `${BAND_LABELS[comparison.band]} of ${PEER_LABELS[comparison.peers]}`;
}

/**
 * The line above a `full` benchmark. A null peer group means the proxy has
 * too few swarms like this one and compared with the whole fleet.
 */
export function fleetPeerGroupNote(peerGroup: FleetPeerGroup | null | undefined): string {
  if (!peerGroup) {
    return "Not enough swarms like yours report yet, so these numbers compare with the whole fleet.";
  }
  const team = optionLabel(TEAM_SIZES, peerGroup.teamSize);
  const parts = [
    team && peerGroup.teamSize !== "1" ? `${team} people` : team,
    optionLabel(USE_CASES, peerGroup.useCase),
  ].filter(Boolean);
  const orgs = `${peerGroup.orgs} ${peerGroup.orgs === 1 ? "organization" : "organizations"}`;
  return `Compared with ${orgs} like yours${parts.length > 0 ? ` (${parts.join(", ")})` : ""}.`;
}

function formatPercent(value: number): string {
  const percent = value * 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(1)}%`;
}

function formatRate(value: number): string {
  return value >= 10 ? String(Math.round(value)) : String(value);
}

export type FleetCardMode = "benchmark" | "progress" | "off" | "perk" | null;

/**
 * What the card shows.
 * - `benchmark`: the comparison is ready.
 * - `progress`: telemetry on and named, but under 10 finished tasks in 30 days.
 * - `off`: telemetry is off and the telemetry banner is not on screen (it
 *   asks for the same thing right above): what telemetry unlocks.
 * - `perk`: no benchmark to show, but a workflow has completed: the Slack
 *   Connect perk alone, until the user submits or dismisses the invite.
 * No org name shows nothing here: the org-name prompt asks for it.
 */
export function fleetCardMode(input: {
  benchmark: FleetBenchmarkResponse | undefined;
  benchmarkDismissed: boolean;
  inviteOpen: boolean;
  workflowRunsCompleted: number;
  /** `/status` reports telemetry off and the telemetry banner does not show. */
  offStateAllowed?: boolean;
}): FleetCardMode {
  const state = input.benchmark?.state;
  if (!input.benchmarkDismissed && state === "ready") return "benchmark";
  if (!input.benchmarkDismissed && state === "not_enough_tasks") return "progress";
  if (!input.benchmarkDismissed && state === "telemetry_off" && input.offStateAllowed) return "off";
  if (input.inviteOpen && input.workflowRunsCompleted > 0) return "perk";
  return null;
}
