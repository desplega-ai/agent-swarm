import { type ReactNode, useMemo } from "react";
import { listConfigs, listRuns } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { type Column, DataTable } from "../components/DataTable.tsx";
import { EntityLink } from "../components/EntityLink.tsx";
import { fmtCost, fmtScore } from "../components/format.ts";
import { HARNESS_LABELS, HarnessIcon } from "../components/HarnessIcon.tsx";
import { ModelChip } from "../components/ModelChip.tsx";
import { PrettyView } from "../components/PrettyView.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import type { AaBenchmarkJson, ConfigJson, RunListItem } from "../types.ts";
import "./configs.css";

/* ---- Artificial Analysis columns (v7.6 item D) ---------------------------- */

const AA_SOURCE = "Artificial Analysis, 2026-06-12 snapshot";

function dim(text = "—"): ReactNode {
  return <span className="dim">{text}</span>;
}

/** "1M" / "922k" → tokens, for sorting the raw context-window display string. */
function ctxWindowSortValue(v: string | null): number | null {
  if (v === null) return null;
  const m = /^(\d+(?:\.\d+)?)([kM])$/.exec(v);
  if (!m) return null;
  return Number(m[1]) * (m[2] === "M" ? 1_000_000 : 1_000);
}

function ProvisionalStar(): ReactNode {
  return (
    <span className="cfg-aa-prov" title="Provisional AA measurement">
      *
    </span>
  );
}

/** Portal hover card for every AA cell: source row + variant note + all metrics. */
function AaTipCard(props: { aa: AaBenchmarkJson }): ReactNode {
  const aa = props.aa;
  const row = (label: string, value: ReactNode) => (
    <div className="tip-card-row">
      <span className="tip-card-label">{label}</span>
      <span className="tip-card-value">{value}</span>
    </div>
  );
  const num = (v: number | null, fmt: (n: number) => string) => (v === null ? dim() : fmt(v));
  return (
    <div className="tip-card">
      <div className="tip-card-title">AA · {aa.sourceRow}</div>
      {aa.matchedVariant !== null ? (
        <div className="cfg-aa-variant">{aa.matchedVariant}</div>
      ) : null}
      {row("Creator", aa.creator ?? dim())}
      {row("Context Window", aa.contextWindow ?? dim())}
      {row(
        "Intelligence",
        aa.intelligenceIndex === null ? (
          dim()
        ) : (
          <>
            {aa.intelligenceIndex}
            {aa.provisional ? <ProvisionalStar /> : null}
          </>
        ),
      )}
      {row(
        "Blended $/1M",
        num(aa.blendedUsdPer1M, (n) => `$${n.toFixed(2)}`),
      )}
      {row(
        "Median Tok/s",
        num(aa.medianTokensPerS, (n) => String(n)),
      )}
      {row(
        "First Chunk",
        num(aa.latencyFirstChunkS, (n) => `${n.toFixed(2)}s`),
      )}
      {row(
        "Total Response",
        num(aa.totalResponseS, (n) => `${n.toFixed(2)}s`),
      )}
      {aa.provisional ? <div className="cfg-aa-variant">* provisional measurement</div> : null}
      <div className="cfg-aa-source">{AA_SOURCE}</div>
    </div>
  );
}

/** AA metric column: right-aligned, sorted on the metric, AaTipCard on hover. */
function aaColumn(opts: {
  key: string;
  header: string;
  headerTip: string;
  width: string;
  sortValue: (aa: AaBenchmarkJson) => number | null;
  render: (aa: AaBenchmarkJson) => ReactNode;
}): Column<ConfigJson> {
  return {
    key: opts.key,
    header: opts.header,
    headerTip: `${opts.headerTip} (${AA_SOURCE})`,
    width: opts.width,
    align: "right",
    sortValue: (c) => (c.aa ? opts.sortValue(c.aa) : null),
    tooltip: (c) => (c.aa ? <AaTipCard aa={c.aa} /> : null),
    // Unmatched configs (no aa block) render nothing but a dim dash.
    render: (c) => (c.aa ? opts.render(c.aa) : dim()),
  };
}

const aaColumns: Column<ConfigJson>[] = [
  aaColumn({
    key: "aaIntel",
    header: "Intel",
    headerTip: "Intelligence index",
    width: "62px",
    sortValue: (aa) => aa.intelligenceIndex,
    render: (aa) =>
      aa.intelligenceIndex === null ? (
        dim()
      ) : (
        <span className="cfg-aa-num">
          {aa.intelligenceIndex}
          {aa.provisional ? <ProvisionalStar /> : null}
        </span>
      ),
  }),
  aaColumn({
    key: "aaBlended",
    header: "$/1M",
    headerTip: "Blended USD per 1M tokens",
    width: "70px",
    sortValue: (aa) => aa.blendedUsdPer1M,
    render: (aa) =>
      aa.blendedUsdPer1M === null ? (
        dim()
      ) : (
        <span className="cfg-aa-num">${aa.blendedUsdPer1M.toFixed(2)}</span>
      ),
  }),
  aaColumn({
    key: "aaTokS",
    header: "Tok/s",
    headerTip: "Median output tokens per second",
    width: "62px",
    sortValue: (aa) => aa.medianTokensPerS,
    render: (aa) =>
      aa.medianTokensPerS === null ? (
        dim()
      ) : (
        <span className="cfg-aa-num">{aa.medianTokensPerS}</span>
      ),
  }),
  aaColumn({
    key: "aaTtfc",
    header: "TTFC",
    headerTip: "Latency to first answer chunk, seconds",
    width: "66px",
    sortValue: (aa) => aa.latencyFirstChunkS,
    render: (aa) =>
      aa.latencyFirstChunkS === null ? (
        dim()
      ) : (
        <span className="cfg-aa-num">{aa.latencyFirstChunkS.toFixed(1)}s</span>
      ),
  }),
  aaColumn({
    key: "aaE2e",
    header: "E2E",
    headerTip: "Total response time, seconds",
    width: "66px",
    sortValue: (aa) => aa.totalResponseS,
    render: (aa) =>
      aa.totalResponseS === null ? (
        dim()
      ) : (
        <span className="cfg-aa-num">{aa.totalResponseS.toFixed(1)}s</span>
      ),
  }),
  aaColumn({
    key: "aaCtx",
    header: "Ctx",
    headerTip: "Context window",
    width: "56px",
    sortValue: (aa) => ctxWindowSortValue(aa.contextWindow),
    render: (aa) =>
      aa.contextWindow === null ? dim() : <span className="cfg-aa-num">{aa.contextWindow}</span>,
  }),
];

/* ---- Configs list ---------------------------------------------------------- */

// Tier and Env Keys columns are deliberately absent: the catalog contract
// (configs/index.test.ts) forbids both on every entry, so they were constant
// "—"/0 noise. Both still show in the hover card and on the detail page.
const configColumns: Column<ConfigJson>[] = [
  {
    key: "config",
    header: "Config",
    width: "200px",
    sortValue: (c) => c.id,
    searchText: (c) => `${c.id} ${c.label ?? ""}`,
    // C5: pretty entry; the raw id lives in the ConfigChip hover card.
    render: (c) => <ConfigChip configId={c.id} />,
  },
  {
    key: "label",
    header: "Label",
    searchText: (c) => c.label ?? "",
    render: (c) => c.label ?? dim(),
  },
  {
    key: "harness",
    header: "Harness",
    width: "120px",
    sortValue: (c) => c.provider,
    filterOptions: (rows) => [...new Set(rows.map((c) => c.provider))].sort(),
    filterValue: (c) => c.provider,
    filterRender: (option) => <HarnessIcon harness={option} showLabel />,
    titleText: (c) => HARNESS_LABELS[c.provider] ?? c.provider,
    render: (c) => <HarnessIcon harness={c.provider} showLabel />,
  },
  {
    key: "model",
    header: "Model",
    width: "170px",
    sortValue: (c) => c.model,
    searchText: (c) => c.model ?? "",
    titleText: (c) => c.model ?? "Harness default model",
    render: (c) => <ModelChip model={c.model} />,
  },
  ...aaColumns,
  {
    key: "default",
    header: "Default",
    width: "64px",
    align: "center",
    sortValue: (c) => (c.isDefault ? 0 : 1),
    titleText: (c) =>
      c.isDefault ? "Default config — included when a run doesn't pick configs" : "Not a default",
    render: (c) =>
      c.isDefault ? (
        <span className="tone-green" role="img" aria-label="Default config">
          ✓
        </span>
      ) : (
        dim()
      ),
  },
];

function ConfigList(): ReactNode {
  const { data, error, loading } = usePoll(listConfigs, null, []);
  return (
    <div className="panel">
      <h3 className="panel-title">Configs{data ? ` · ${data.length}` : ""}</h3>
      {error ? <div className="cfg-error">{error}</div> : null}
      {loading && !data ? <Spinner label="Loading configs…" /> : null}
      {data ? (
        <DataTable
          rows={data}
          columns={configColumns}
          rowKey={(c) => c.id}
          onRowClick={(c) => navigate(`#/configs/${c.id}`)}
          defaultSort={{ key: "config", dir: "asc" }}
          searchPlaceholder="Search configs…"
          emptyText="No configs registered"
        />
      ) : null}
    </div>
  );
}

/** Per-scenario aggregate of every recorded run cell that used this config. */
interface ScenarioAgg {
  scenarioId: string;
  runs: number;
  passedRuns: number;
  attempts: number;
  bestScore: number | null;
  totalCostUsd: number | null;
}

function aggregateByScenario(runs: RunListItem[], configId: string): ScenarioAgg[] {
  const byScenario = new Map<string, ScenarioAgg>();
  for (const item of runs) {
    for (const cell of item.cells) {
      if (cell.configId !== configId) continue;
      let agg = byScenario.get(cell.scenarioId);
      if (!agg) {
        agg = {
          scenarioId: cell.scenarioId,
          runs: 0,
          passedRuns: 0,
          attempts: 0,
          bestScore: null,
          totalCostUsd: null,
        };
        byScenario.set(cell.scenarioId, agg);
      }
      agg.runs += 1;
      if (cell.passedAny) agg.passedRuns += 1;
      agg.attempts += cell.attempts;
      if (cell.bestScore !== null) {
        agg.bestScore =
          agg.bestScore === null ? cell.bestScore : Math.max(agg.bestScore, cell.bestScore);
      }
      if (cell.totalCostUsd !== null)
        agg.totalCostUsd = (agg.totalCostUsd ?? 0) + cell.totalCostUsd;
    }
  }
  return [...byScenario.values()];
}

const aggColumns: Column<ScenarioAgg>[] = [
  {
    key: "scenario",
    header: "Scenario",
    searchText: (r) => r.scenarioId,
    render: (r) => <EntityLink kind="scenario" id={r.scenarioId} />,
  },
  {
    key: "runs",
    header: "Runs",
    width: "60px",
    align: "right",
    sortValue: (r) => r.runs,
    render: (r) => r.runs,
  },
  {
    key: "attempts",
    header: "Attempts",
    width: "78px",
    align: "right",
    sortValue: (r) => r.attempts,
    render: (r) => r.attempts,
  },
  {
    key: "passed",
    header: "Passed",
    headerTip: "Runs where at least one attempt of this cell passed",
    width: "72px",
    align: "right",
    sortValue: (r) => (r.runs === 0 ? null : r.passedRuns / r.runs),
    titleText: (r) => `${r.passedRuns} of ${r.runs} runs passed at least one attempt`,
    render: (r) => {
      const tone =
        r.passedRuns === r.runs ? "tone-green" : r.passedRuns === 0 ? "tone-red" : "tone-accent";
      return (
        <span className={`cfg-pass ${tone}`}>
          {r.passedRuns}/{r.runs}
        </span>
      );
    },
  },
  {
    key: "best",
    header: "Best Score",
    width: "84px",
    align: "right",
    sortValue: (r) => r.bestScore,
    render: (r) => fmtScore(r.bestScore),
  },
  {
    key: "cost",
    header: "Cost",
    width: "90px",
    align: "right",
    sortValue: (r) => r.totalCostUsd,
    render: (r) => fmtCost(r.totalCostUsd),
  },
];

function ConfigDetail(props: { configId: string }): ReactNode {
  const configs = usePoll(listConfigs, null, []);
  const runs = usePoll(listRuns, null, []);
  const config = configs.data?.find((c) => c.id === props.configId) ?? null;
  const aggs = useMemo(
    () => (runs.data ? aggregateByScenario(runs.data, props.configId) : []),
    [runs.data, props.configId],
  );

  if (!configs.data) {
    return (
      <div className="panel">
        <a className="entity-link" href="#/configs">
          ← Configs
        </a>
        {configs.loading ? (
          <div className="cfg-loading">
            <Spinner label="Loading config…" />
          </div>
        ) : null}
        {configs.error ? <div className="cfg-error">{configs.error}</div> : null}
      </div>
    );
  }

  return (
    <>
      <div className="panel cfg-header">
        <a className="entity-link" href="#/configs">
          ← Configs
        </a>
        <h2 className="cfg-title">
          <HarnessIcon harness={config?.provider ?? null} size={18} />
          {config?.label ?? props.configId}
        </h2>
        <span className="chip">{props.configId}</span>
        {config?.isDefault ? (
          <Tooltip text="Default config — included when a run doesn't pick configs">
            <span className="tone-green cfg-default" role="img" aria-label="Default config">
              ✓
            </span>
          </Tooltip>
        ) : null}
        {configs.error ? <span className="cfg-error">{configs.error}</span> : null}
      </div>
      {config ? (
        <div className="panel">
          <h3 className="panel-title">
            Definition <InfoTip text="Env values stay server-side — only key names are exposed" />
          </h3>
          <PrettyView
            value={config}
            rawLabel="config"
            labels={{
              provider: "Harness",
              isDefault: "Default",
              aa: "Artificial Analysis (2026-06-12)",
              sourceRow: "Source Row",
              matchedVariant: "Matched Variant",
              contextWindow: "Context Window",
              intelligenceIndex: "Intelligence Index",
              blendedUsdPer1M: "Blended $ / 1M Tokens",
              medianTokensPerS: "Median Tokens/s",
              latencyFirstChunkS: "First Chunk (s)",
              totalResponseS: "Total Response (s)",
            }}
            renderers={{
              provider: (v) => <HarnessIcon harness={typeof v === "string" ? v : null} showLabel />,
              model: (v) => <ModelChip model={typeof v === "string" ? v : null} />,
              blendedUsdPer1M: (v) => (typeof v === "number" ? `$${v.toFixed(2)}` : dim()),
              latencyFirstChunkS: (v) => (typeof v === "number" ? `${v.toFixed(2)}s` : dim()),
              totalResponseS: (v) => (typeof v === "number" ? `${v.toFixed(2)}s` : dim()),
            }}
          />
        </div>
      ) : (
        <div className="panel">
          <h3 className="panel-title">Definition</h3>
          <div className="dim">
            Config "{props.configId}" is not in the registry — it may have been removed. Recorded
            runs keep their results below.
          </div>
        </div>
      )}
      <div className="panel">
        <h3 className="panel-title">
          Results by Scenario{" "}
          <InfoTip text="Aggregated from recorded runs that include this config" />
        </h3>
        {runs.error ? <div className="cfg-error">{runs.error}</div> : null}
        {runs.loading && !runs.data ? <Spinner label="Loading runs…" /> : null}
        {runs.data ? (
          <DataTable
            rows={aggs}
            columns={aggColumns}
            rowKey={(r) => r.scenarioId}
            defaultSort={{ key: "scenario", dir: "asc" }}
            searchable={false}
            emptyText="No recorded runs include this config"
          />
        ) : null}
      </div>
    </>
  );
}

/**
 * Harness-configs page (item 12): list at #/configs, detail at #/configs/:id.
 * The props contract ({ configId: string | null }) is frozen by App.tsx routing.
 */
export default function ConfigsPage(props: { configId: string | null }): ReactNode {
  return props.configId === null ? <ConfigList /> : <ConfigDetail configId={props.configId} />;
}
