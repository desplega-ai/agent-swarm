import type { ReactNode } from "react";
import { buildAttemptOutcome, type OutcomeVerdict } from "../lib/attempt-outcome.ts";
import type { JudgmentJson } from "../types.ts";
import { fmtScore, humanizeKey } from "./format.ts";
import "./attempt-outcome.css";

const VERDICT_TEXT: Record<OutcomeVerdict, { title: string; note: string | null }> = {
  passed: { title: "Passed", note: null },
  failed: { title: "Failed", note: "The agent ran and was graded below the pass line." },
  error: {
    title: "Error: not scored",
    note: "The attempt broke before it could be graded (harness, sandbox or provider). It is counted apart from failures and left out of pass rates.",
  },
  cancelled: { title: "Cancelled", note: "Stopped before it finished. Not graded." },
  unfinished: { title: "In progress", note: "Gates and dimensions appear as the judges finish." },
};

function Bar(props: { score: number | null }): ReactNode {
  const pct = props.score === null ? 0 : Math.max(0, Math.min(1, props.score)) * 100;
  return (
    <span className="ao-bar" aria-hidden="true">
      <span className="ao-bar-fill" style={{ width: `${pct}%` }} />
    </span>
  );
}

/**
 * Read this before the transcript: the verdict, the gates the attempt had to
 * clear, then each scored dimension with a one-line reason. The Checks tab keeps
 * the full reasoning and judge traces.
 */
export function AttemptOutcome(props: {
  status: string;
  score: number | null;
  judgments: JudgmentJson[];
}): ReactNode {
  const view = buildAttemptOutcome(props.status, props.judgments);
  const text = VERDICT_TEXT[view.verdict];
  const empty = view.gates.length === 0 && view.dimensions.length === 0;
  return (
    <div className="panel ao">
      <div className="panel-title">Outcome</div>
      <div className={`ao-verdict ao-${view.verdict}`}>
        <span className="ao-verdict-title">{text.title}</span>
        {props.score !== null && view.verdict !== "error" ? (
          <span className="ao-verdict-score">{fmtScore(props.score)}</span>
        ) : null}
      </div>
      {text.note !== null ? <div className="ao-note dim">{text.note}</div> : null}
      {view.gates.length > 0 ? (
        <section className="ao-section">
          <div className="ao-label">Gates</div>
          <ul className="ao-list">
            {view.gates.map((g) => (
              <li key={g.name} className="ao-row">
                <span className={g.pass ? "ao-mark ao-pass" : "ao-mark ao-fail"}>
                  {g.pass ? "✓" : "✗"}
                </span>
                <span className="ao-name">{humanizeKey(g.name)}</span>
                {g.reason !== null ? (
                  <span className="ao-reason dim" title={g.reason}>
                    {g.reason}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {view.dimensions.length > 0 ? (
        <section className="ao-section">
          <div className="ao-label">
            Dimensions
            <span className="ao-agg" title="Weighted mean of the dimension scores">
              {fmtScore(view.aggregate)}
            </span>
          </div>
          <ul className="ao-list">
            {view.dimensions.map((d) => (
              <li key={d.name} className="ao-dim">
                <span className="ao-dim-head">
                  <span className="ao-name">{humanizeKey(d.name)}</span>
                  <span className="dim ao-weight">×{fmtScore(d.weight)}</span>
                  <Bar score={d.score} />
                  <span className="ao-score">{fmtScore(d.score)}</span>
                </span>
                {d.reason !== null ? (
                  <span className="ao-reason dim" title={d.reason}>
                    {d.reason}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {empty && view.verdict !== "unfinished" && view.verdict !== "error" ? (
        <div className="dim ao-note">No judgments were recorded for this attempt.</div>
      ) : null}
    </div>
  );
}
