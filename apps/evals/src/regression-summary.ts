/**
 * The one Slack message a scheduled run posts (Phase 9). Pure: turns a
 * {@link RegressionReport} into mrkdwn text. Posting lives in `api/run-completion.ts`.
 */

import {
  type CellReport,
  type CellStatus,
  COST_DRIFT_RATIO,
  type RegressionReport,
} from "./regression.ts";

export interface SummaryRun {
  id: string;
  name: string | null;
  preset: string;
  status: string;
  maxMeteredUsd: number | null;
  /** Link to the run in the evals UI. */
  url: string;
}

const PRESET_LABELS: Record<string, string> = {
  "nightly-canary": "Nightly canary",
  "weekly-matrix": "Weekly matrix",
};

export function presetLabel(preset: string): string {
  return PRESET_LABELS[preset] ?? preset;
}

const usd = (x: number): string => `$${x.toFixed(2)}`;

/** Marker after `passed/graded` in the table; empty for statuses that need no callout. */
const CELL_MARK: Partial<Record<CellStatus, string>> = {
  page: " PAGE",
  flag: " flag",
  cleared: " cleared",
  "score-drop": " score",
  quarantine: " quar",
  broken: " broken",
  "no-data": "",
};

function cellText(cell: CellReport | undefined): string {
  if (!cell) return "-";
  if (cell.graded === 0) return cell.errors > 0 ? `err ${cell.errors}` : "-";
  return `${cell.passed}/${cell.graded}${CELL_MARK[cell.status] ?? ""}`;
}

function padRow(cols: string[], widths: number[]): string {
  return cols
    .map((c, i) => c.padEnd(widths[i] ?? 0))
    .join("  ")
    .trimEnd();
}

/** Scenario x config table, in scenario order, as a code block. */
function renderTable(report: RegressionReport, scenarioOrder: string[]): string {
  const configIds = report.configs.map((c) => c.configId);
  const byCell = new Map(report.cells.map((c) => [`${c.scenarioId}\u0000${c.configId}`, c]));
  const seen = new Set(report.cells.map((c) => c.scenarioId));
  const scenarios = [
    ...scenarioOrder.filter((id) => seen.has(id)),
    ...[...seen].filter((id) => !scenarioOrder.includes(id)),
  ];
  const header = ["scenario", ...configIds];
  const rows = scenarios.map((s) => [
    s,
    ...configIds.map((c) => cellText(byCell.get(`${s}\u0000${c}`))),
  ]);
  const widths = header.map((_, i) => Math.max(...[header, ...rows].map((r) => r[i]?.length ?? 0)));
  return ["```", padRow(header, widths), ...rows.map((r) => padRow(r, widths)), "```"].join("\n");
}

function bullets(title: string, lines: string[]): string[] {
  return lines.length > 0 ? ["", `*${title}*`, ...lines.map((l) => `• ${l}`)] : [];
}

const cellLine = (c: CellReport): string => `${c.scenarioId} × ${c.configId}: ${c.note}`;

export function formatRunSummary(
  run: SummaryRun,
  report: RegressionReport,
  scenarioOrder: string[] = [],
): string {
  const label = presetLabel(run.preset);
  const cellsWith = (...statuses: CellStatus[]) =>
    report.cells.filter((c) => statuses.includes(c.status));
  const drift = report.configs.flatMap((c) => {
    const lines: string[] = [];
    if (c.meteredDrift && c.medianMeteredUsd !== null) {
      lines.push(
        `${c.configId}: metered ${usd(c.meteredUsd)} vs ${usd(c.medianMeteredUsd)} median (over ${COST_DRIFT_RATIO}x)`,
      );
    }
    if (c.notionalDrift && c.medianNotionalUsd !== null) {
      lines.push(
        `${c.configId}: notional ${usd(c.notionalUsd)} vs ${usd(c.medianNotionalUsd)} median (over ${COST_DRIFT_RATIO}x)`,
      );
    }
    return lines;
  });
  const modelChanges = report.configs
    .filter((c) => c.modelChanged)
    .map(
      (c) =>
        `${c.configId}: ${c.previousModel ?? "unknown"} → ${c.model ?? "unknown"}; the baseline restarts, nothing is compared`,
    );
  const infra = report.configs
    .filter((c) => c.errors > 0)
    .map(
      (c) =>
        `${c.configId}: ${c.errors} of ${c.attempts} attempts errored (${c.rateLimited} read as rate limits)`,
    );
  if (report.totals.cancelled > 0) {
    infra.push(
      `${report.totals.cancelled} attempts were cancelled before they ran (cost cap or cancel)`,
    );
  }
  const waiting = cellsWith("no-baseline").length;

  const headline = report.page
    ? `:rotating_light: *${label}: PAGE*`
    : report.flagged
      ? `:warning: *${label}: flags to look at*`
      : `:white_check_mark: *${label}: clean*`;
  const cap = run.maxMeteredUsd !== null ? ` of ${usd(run.maxMeteredUsd)} cap` : "";
  const t = report.totals;
  const lines = [
    headline,
    `<${run.url}|${run.name ?? run.id}> · ${t.attempts} attempts: ${t.passed} passed, ${t.failed} failed, ${t.errors} errored · ${usd(t.meteredUsd)} metered${cap} · ${usd(t.notionalUsd)} notional`,
    "",
    renderTable(report, scenarioOrder),
    ...bullets("Pages", cellsWith("page").map(cellLine)),
    ...bullets("Flags", cellsWith("flag", "score-drop", "cleared").map(cellLine)),
    ...bullets("Cost drift", drift),
    ...bullets("Model changes", modelChanges),
    ...bullets("Infra", infra),
    ...bullets(
      "Quarantined or broken",
      cellsWith("quarantine", "broken").map(
        (c) =>
          `${c.scenarioId} × ${c.configId}: ${c.status}, passes ${c.baseline.passRate === null ? "?" : `${Math.round(c.baseline.passRate * 100)}%`} of the baseline`,
      ),
    ),
  ];
  if (waiting > 0) {
    lines.push("", `_Baseline still building for ${waiting} of ${report.cells.length} cells._`);
  }
  return lines.join("\n");
}

/** Summary of a scheduled run that did not finish `done`: no regression check, just the state. */
export function formatRunFailureSummary(
  run: SummaryRun,
  counts: { attempts: number; passed: number; errors: number; cancelled: number },
): string {
  return [
    `:x: *${presetLabel(run.preset)}: run ${run.status}*`,
    `<${run.url}|${run.name ?? run.id}> · ${counts.attempts} attempts: ${counts.passed} passed, ${counts.errors} errored, ${counts.cancelled} cancelled. No regression check ran.`,
  ].join("\n");
}
