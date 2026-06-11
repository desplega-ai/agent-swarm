import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createRun, listConfigs, listScenarios } from "../api.ts";
import { ConfigChip } from "../components/ConfigChip.tsx";
import { fuzzyMatch } from "../components/DataTable.tsx";
import { fmtPerM, fmtTokens } from "../components/format.ts";
import { ModelChip } from "../components/ModelChip.tsx";
import { Spinner } from "../components/Spinner.tsx";
import { InfoTip, Tooltip } from "../components/Tooltip.tsx";
import { navigate, useModels, usePoll } from "../hooks.ts";
import type { CreateRunBody } from "../types.ts";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(n)));
}

const EDGE = 8; // min distance from viewport edges (mirrors DataTable's MultiSelect)

interface MenuPos {
  left: number;
  top: number;
  width: number;
}

function NewRunForm(props: { onClose: () => void }): ReactNode {
  const scenarios = usePoll(listScenarios, null, []);
  const configs = usePoll(listConfigs, null, []);
  const models = useModels();

  const [name, setName] = useState("");
  // null = user hasn't touched yet → defaults derive from the fetched lists.
  const [scenarioSel, setScenarioSel] = useState<Set<string> | null>(null);
  const [configSel, setConfigSel] = useState<Set<string> | null>(null);
  const [judgeModel, setJudgeModel] = useState<string | null>(null);
  const [attempts, setAttempts] = useState(1);
  const [concurrency, setConcurrency] = useState(2);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<MenuPos | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const firstScenario = scenarios.data?.[0]?.id;
  const selScenarios = scenarioSel ?? new Set(firstScenario !== undefined ? [firstScenario] : []);
  const selConfigs =
    configSel ?? new Set((configs.data ?? []).filter((c) => c.isDefault).map((c) => c.id));
  const judge = judgeModel ?? models.defaultJudgeModel ?? "";

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
    const q = judge.trim();
    const filtered =
      q.length > 0
        ? models.models.filter((m) => fuzzyMatch(q, `${m.id} ${m.name}`))
        : models.models;
    return filtered.slice(0, 12);
  }, [models.models, judge]);

  // Item 1 — the judge-model menu must NEVER scroll the modal. It renders with
  // position: fixed (viewport coords), so it contributes nothing to the dialog's
  // scrollable overflow — structurally, not incidentally. It stays INSIDE the
  // dialog subtree (not portaled to document.body): the open modal sits in the
  // browser's top layer, which paints above — and makes inert — everything
  // outside it, so a body-level menu would be invisible and unclickable.
  // Positioning mechanics mirror DataTable's MultiSelect: anchor to the input
  // rect, flip above when there is no room below, clamp x to the viewport.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reposition when the match list changes the menu height
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const input = inputRef.current;
    const menu = menuRef.current;
    if (!input || !menu) return;
    const anchor = input.getBoundingClientRect();
    menu.style.width = `${anchor.width}px`; // apply before measuring the height
    const menuHeight = menu.getBoundingClientRect().height;
    const left = Math.max(EDGE, Math.min(anchor.left, window.innerWidth - EDGE - anchor.width));
    let top = anchor.bottom + 4;
    if (top + menuHeight > window.innerHeight - EDGE) top = anchor.top - 4 - menuHeight;
    setMenuPos({ left, top: Math.max(EDGE, top), width: anchor.width });
  }, [menuOpen, matches.length]);

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || inputRef.current?.contains(t)) return;
      setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault(); // close the menu only — keep the dialog open
      setMenuOpen(false);
    };
    const onResize = () => setMenuOpen(false); // stale positions are worse than no menu
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
    };
  }, [menuOpen]);

  const resolvedJudge = models.resolve(judge.trim().length > 0 ? judge.trim() : null);

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
        <h3 className="dialog-title">New Run</h3>
        {loadError ? (
          <div className="form-error">Failed to load: {loadError}</div>
        ) : (
          <Spinner label="Loading scenarios + configs…" />
        )}
        <div className="dialog-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Close
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
      <h3 className="dialog-title">New Run</h3>

      <div className="form-field">
        <span className="form-label">
          Name{" "}
          <InfoTip text="Optional display name for the runs list — a run id is generated either way" />
        </span>
        <input
          type="text"
          value={name}
          placeholder="Nightly, smoke, …"
          onChange={(e) => setName(e.target.value)}
        />
      </div>

      <div className="form-field">
        <span className="form-label">
          Scenarios{" "}
          <InfoTip text="What gets evaluated — every selected scenario becomes a matrix row" />
        </span>
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
        <span className="form-label">
          Configs{" "}
          <InfoTip text="Harness × model under test — every selected config becomes a matrix column" />
        </span>
        <div className="check-list">
          {configs.data.map((c) => (
            <label key={c.id}>
              <input
                type="checkbox"
                checked={selConfigs.has(c.id)}
                onChange={() => toggleConfig(c.id)}
              />
              <ConfigChip configId={c.id} />
            </label>
          ))}
        </div>
      </div>

      <div className="form-row-2">
        <div className="form-field">
          <span className="form-label">
            Attempts Per Cell{" "}
            <InfoTip text="Independent attempts per scenario × config cell — pass@n/best@n scoring" />
          </span>
          <input
            type="number"
            min={1}
            max={10}
            value={attempts}
            onChange={(e) => setAttempts(Number(e.target.value) || 1)}
          />
        </div>
        <div className="form-field">
          <span className="form-label">
            Concurrency{" "}
            <InfoTip text="Attempts executed in parallel — each boots its own E2B sandbox stack" />
          </span>
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
          Judge Model <InfoTip text="Bare OpenRouter id; scenario-level judge models still win" />
        </span>
        <div className="model-select">
          <input
            ref={inputRef}
            type="text"
            value={judge}
            placeholder="deepseek/deepseek-v4-pro"
            spellCheck={false}
            onChange={(e) => {
              setJudgeModel(e.target.value);
              setMenuOpen(true);
            }}
            onFocus={() => setMenuOpen(true)}
            onClick={() => setMenuOpen(true)} // reopen on click when already focused
            onBlur={() => setMenuOpen(false)}
          />
          {menuOpen && matches.length > 0 ? (
            <div
              ref={menuRef}
              className="model-menu"
              style={
                menuPos
                  ? { left: menuPos.left, top: menuPos.top, width: menuPos.width }
                  : { left: -9999, top: -9999, visibility: "hidden" }
              }
            >
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
        {resolvedJudge !== null ? (
          <div className="judge-preview">
            <span className="dim">Resolves to </span>
            <ModelChip model={judge.trim()} />
          </div>
        ) : null}
      </div>

      {error ? <div className="form-error">{error}</div> : null}

      <div className="dialog-actions">
        <button type="button" className="btn" onClick={props.onClose}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={!canSubmit}>
          {submitting ? "Starting…" : "Start Run"}
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
