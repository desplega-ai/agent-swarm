import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { createRun, getModels, listConfigs, listScenarios } from "../api.ts";
import { fuzzyMatch } from "../components/DataTable.tsx";
import { fmtTokens } from "../components/format.ts";
import { Spinner } from "../components/Spinner.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, usePoll } from "../hooks.ts";
import type { CreateRunBody } from "../types.ts";

function fmtPerM(v: number | null): string {
  if (v === null || Number.isNaN(v)) return "—";
  return `$${Number(v.toFixed(4))}`;
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

function NewRunForm(props: { onClose: () => void }): ReactNode {
  const scenarios = usePoll(listScenarios, null, []);
  const configs = usePoll(listConfigs, null, []);
  const models = usePoll(getModels, null, []);

  const [name, setName] = useState("");
  // null = user hasn't touched yet → defaults derive from the fetched lists.
  const [scenarioSel, setScenarioSel] = useState<Set<string> | null>(null);
  const [configSel, setConfigSel] = useState<Set<string> | null>(null);
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(1);
  const [concurrency, setConcurrency] = useState(2);
  const [menuOpen, setMenuOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const firstScenario = scenarios.data?.[0]?.id;
  const selScenarios = scenarioSel ?? new Set(firstScenario !== undefined ? [firstScenario] : []);
  const selConfigs =
    configSel ?? new Set((configs.data ?? []).filter((c) => c.isDefault).map((c) => c.id));
  const judge = judgeModel ?? models.data?.defaultJudgeModel ?? "";

  const toggleScenario = (id: string) => {
    const next = new Set(selScenarios);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setScenarioSel(next);
  };
  const toggleConfig = (id: string) => {
    const next = new Set(selConfigs);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setConfigSel(next);
  };

  const matches = useMemo(() => {
    const all = models.data?.models ?? [];
    const q = judge.trim();
    const filtered = q.length > 0 ? all.filter((m) => fuzzyMatch(q, `${m.id} ${m.name}`)) : all;
    return filtered.slice(0, 12);
  }, [models.data, judge]);

  const canSubmit = selScenarios.size > 0 && selConfigs.size > 0 && !submitting;

  const submit = async () => {
    setError(null);
    setSubmitting(true);
    try {
      const body: CreateRunBody = {
        // preserve listing order, not toggle order
        scenarioIds: (scenarios.data ?? []).filter((s) => selScenarios.has(s.id)).map((s) => s.id),
        configIds: (configs.data ?? []).filter((c) => selConfigs.has(c.id)).map((c) => c.id),
        attemptsPerCell: clamp(attempts, 1, 10),
        concurrency: clamp(concurrency, 1, 8),
      };
      if (name.trim().length > 0) body.name = name.trim();
      if (judge.trim().length > 0) body.judgeModel = judge.trim();
      const { runId } = await createRun(body);
      props.onClose();
      navigate(`#/runs/${runId}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  };

  if (scenarios.data === null || configs.data === null) {
    const loadError = scenarios.error ?? configs.error;
    return (
      <div className="new-run-body">
        <h3 className="dialog-title">new run</h3>
        {loadError ? (
          <div className="form-error">failed to load: {loadError}</div>
        ) : (
          <Spinner label="loading scenarios + configs…" />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            close
          </button>
        </div>
      </div>
    );
  }

  return (
    <form
      className="new-run-body"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <h3 className="dialog-title">new run</h3>

      <div className="form-field">
        <span className="form-label">name (optional)</span>
        <input
          type="text"
          value={name}
          placeholder="nightly, smoke, …"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="form-field">
        <span className="form-label">scenarios</span>
        <div className="check-list">
          {scenarios.data.map((s) => (
            <Tooltip key={s.id} text={s.name}>
              <label>
                <input
                  type="checkbox"
                  checked={selScenarios.has(s.id)}
                  onChange={() => toggleScenario(s.id)}
                />
                {s.id}
              </label>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="form-field">
        <span className="form-label">configs</span>
        <div className="check-list">
          {configs.data.map((c) => (
            <Tooltip key={c.id} text={`${c.label ?? c.id}${c.model ? ` · ${c.model}` : ""}`}>
              <label>
                <input
                  type="checkbox"
                  checked={selConfigs.has(c.id)}
                  onChange={() => toggleConfig(c.id)}
                />
                {c.id}
              </label>
            </Tooltip>
          ))}
        </div>
      </div>

      <div className="form-row-2">
        <div className="form-field">
          <span className="form-label">attempts per cell</span>
          <input
            type="number"
            min={1}
            max={10}
            value={attempts}
            onChange={(e) => setAttempts(Number(e.target.value) || 1)}
          />
        </div>
        <div className="form-field">
          <span className="form-label">concurrency</span>
          <input
            type="number"
            min={1}
            max={8}
            value={concurrency}
            onChange={(e) => setConcurrency(Number(e.target.value) || 1)}
          />
        </div>
      </div>

      <div className="form-field">
        <span className="form-label">
          judge model <InfoTip text="bare OpenRouter id; scenario-level judge models still win" />
        </span>
        <div className="model-select">
          <input
            type="text"
            value={judge}
            placeholder="deepseek/deepseek-v4-pro"
            spellCheck={false}
            onChange={(e) => {
              setJudgeModel(e.target.value);
              setMenuOpen(true);
            }}
            onFocus={() => setMenuOpen(true)}
            onBlur={() => setMenuOpen(false)}
          />
          {menuOpen && matches.length > 0 ? (
            <div className="model-menu">
              {matches.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  className="model-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setJudgeModel(m.id);
                    setMenuOpen(false);
                  }}
                >
                  <span className="model-name">{m.name}</span>
                  <span className="model-meta dim">
                    {fmtPerM(m.inputPerM)}/{fmtPerM(m.outputPerM)} per 1M · ctx{" "}
                    {fmtTokens(m.context)}
                  </span>
                  <span className="model-id dim">{m.id}</span>
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      {error ? <div className="form-error">{error}</div> : null}

      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {submitting ? "starting…" : "start run"}
        </button>
      </div>
    </form>
  );
}

export function NewRunDialog(props: { open: boolean; onClose: () => void }): ReactNode {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (props.open && !el.open) el.showModal();
    else if (!props.open && el.open) el.close();
  }, [props.open]);

  return (
    <dialog ref={ref} className="new-run-dialog" onClose={props.onClose}>
      {/* body mounts per open → fresh data + defaults each time */}
      {props.open ? <NewRunForm onClose={props.onClose} /> : null}
    </dialog>
  );
}
