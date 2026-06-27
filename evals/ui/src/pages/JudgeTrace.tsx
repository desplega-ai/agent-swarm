import { type ReactNode, useState } from "react";
import { fmtCost, fmtDuration, fmtTokens } from "../components/format.ts";
import { ModelChip } from "../components/ModelChip.tsx";
import { Elapsed, Spinner } from "../components/Spinner.tsx";
import { Tooltip } from "../components/Tooltip.tsx";
import type { JudgeStepJson, JudgeTraceJson, TokenTotalsJson } from "../types.ts";

const JUDGE_LABELS: Record<string, string> = {
  agentic: "Agentic Judge",
  llm: "LLM Judge",
  deterministic: "Checks",
};

const JUDGE_COST_TIP = "Judge LLM cost — not included in attempt cost";

/** Clipped pretty-JSON for tooltips (args are small by construction, but stay safe). */
function prettyJson(value: unknown, max = 1600): string {
  let text: string;
  try {
    text = JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    text = String(value);
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function tokensTip(tokens: TokenTotalsJson): string {
  return [
    `Input ${fmtTokens(tokens.inputTokens)} · Output ${fmtTokens(tokens.outputTokens)}`,
    `Cache Read ${fmtTokens(tokens.cacheReadTokens)} · Cache Write ${fmtTokens(
      tokens.cacheWriteTokens,
    )}`,
  ].join("\n");
}

function TokensBadge(props: { tokens: TokenTotalsJson }): ReactNode {
  const total = props.tokens.inputTokens + props.tokens.outputTokens;
  return (
    <Tooltip text={tokensTip(props.tokens)}>
      <span className="jt-badge">⧉ {fmtTokens(total)}</span>
    </Tooltip>
  );
}

/**
 * Judge-trace showcase (v3 spec §8.1): per-judge header (kind glyph, ModelChip,
 * judge cost, duration, tokens) + step timeline. Reasoning blocks are PROMINENT;
 * tool call/result pairs collapse their output; checks carry per-check ms.
 */
export default function JudgeTrace(props: {
  trace: JudgeTraceJson;
  /** True while the trace is still being appended (live registry stream). */
  live?: boolean;
}): ReactNode {
  const { trace, live } = props;
  const label = JUDGE_LABELS[trace.judge] ?? trace.judge;
  const glyph = trace.judge === "deterministic" ? "≡" : "✶";
  const running = live === true && trace.finishedAt === null;
  const className = live === true ? (running ? "jt jt-card jt-running" : "jt jt-card") : "jt";
  return (
    <div className={className}>
      <div className="jt-head">
        <Tooltip text={label}>
          <span className="jt-kind" role="img" aria-label={label}>
            {glyph}
          </span>
        </Tooltip>
        <span className="jt-title">{label}</span>
        {trace.judge !== "deterministic" ? <ModelChip model={trace.model} /> : null}
        <span className="jt-spacer" />
        {trace.tokens ? <TokensBadge tokens={trace.tokens} /> : null}
        <Tooltip text={JUDGE_COST_TIP}>
          <span className={trace.costUsd === null ? "cost-badge dim" : "cost-badge"}>
            {fmtCost(trace.costUsd)}
          </span>
        </Tooltip>
        <Tooltip text={running ? "Elapsed (still judging)" : "Total judge duration"}>
          <span className="jt-badge">
            {running ? <Elapsed since={trace.startedAt} /> : fmtDuration(trace.durationMs)}
          </span>
        </Tooltip>
      </div>
      {trace.error !== null ? <div className="jt-error">{trace.error}</div> : null}
      <div className="jt-steps">
        {trace.steps.map((step, i) => (
          <StepBlock step={step} key={`${step.kind}-${step.startedAt}-${String(i)}`} />
        ))}
        {running ? (
          <div className="jt-live-row">
            <Spinner label="Judging…" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function StepBlock(props: { step: JudgeStepJson }): ReactNode {
  const { step } = props;
  if (step.kind === "reasoning") return <ReasoningStep step={step} />;
  if (step.kind === "tool") return <ToolStep step={step} />;
  if (step.kind === "check") return <CheckStep step={step} />;
  return <ErrorStep step={step} />;
}

// ---- reasoning (PROMINENT — this is what matters most) ----

function ReasoningStep(props: { step: JudgeStepJson }): ReactNode {
  const { step } = props;
  return (
    <div className="jt-step jt-reasoning">
      {step.text !== null && step.text.length > 0 ? (
        <div className="jt-reasoning-text">{step.text}</div>
      ) : (
        <div className="jt-reasoning-text dim">Model call</div>
      )}
      <div className="jt-step-meta">
        {step.durationMs !== null ? (
          <Tooltip text="Model call elapsed">
            <span className="jt-badge">{fmtDuration(step.durationMs)}</span>
          </Tooltip>
        ) : null}
        {step.tokens ? <TokensBadge tokens={step.tokens} /> : null}
        {step.costUsd !== null ? (
          <Tooltip text={JUDGE_COST_TIP}>
            <span className="jt-badge">{fmtCost(step.costUsd)}</span>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

// ---- tool call/result pair ----

function ToolStep(props: { step: JudgeStepJson }): ReactNode {
  const { step } = props;
  const hasArgs = step.args !== null && step.args !== undefined;
  return (
    <div className="jt-step jt-tool">
      <div className="jt-tool-head">
        <span className="jt-tool-glyph" role="img" aria-label="Tool call">
          ⚙
        </span>
        <code className="jt-tool-name">{step.tool ?? "tool"}</code>
        {hasArgs ? (
          <Tooltip wide text={prettyJson(step.args)}>
            <span className="jt-args">{compactJson(step.args)}</span>
          </Tooltip>
        ) : (
          <span className="jt-args dim">No args</span>
        )}
        {step.durationMs !== null ? (
          <Tooltip text="Tool elapsed">
            <span className="jt-badge">{fmtDuration(step.durationMs)}</span>
          </Tooltip>
        ) : null}
      </div>
      {step.output !== null && step.output.length > 0 ? <ToolOutput output={step.output} /> : null}
    </div>
  );
}

function ToolOutput(props: { output: string }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <div className="jt-output">
      <button type="button" className="pv-toggle" onClick={() => setOpen((o) => !o)}>
        {open ? "▾" : "▸"} Output ({props.output.length.toLocaleString()} chars)
      </button>
      {open ? <pre className="jt-output-body">{props.output}</pre> : null}
    </div>
  );
}

// ---- deterministic check row ----

function CheckStep(props: { step: JudgeStepJson }): ReactNode {
  const { step } = props;
  const glyph =
    step.pass === true ? (
      <span className="tone-green" role="img" aria-label="Pass">
        ✓
      </span>
    ) : step.pass === false ? (
      <span className="tone-red" role="img" aria-label="Fail">
        ✗
      </span>
    ) : (
      <span className="tone-dim" role="img" aria-label="Unknown">
        ○
      </span>
    );
  return (
    <div className="jt-step jt-check">
      {glyph}
      <code className="jt-check-name">{step.tool ?? "check"}</code>
      {step.text !== null && step.text.length > 0 ? (
        <span className="jt-check-detail" title={step.text}>
          {step.text}
        </span>
      ) : (
        <span className="jt-check-detail" />
      )}
      <Tooltip text="Check elapsed">
        <span className="jt-badge">{fmtDuration(step.durationMs)}</span>
      </Tooltip>
    </div>
  );
}

// ---- error step ----

function ErrorStep(props: { step: JudgeStepJson }): ReactNode {
  return (
    <div className="jt-step jt-error-step">
      <span role="img" aria-label="Error">
        ⚠
      </span>{" "}
      {props.step.text ?? "Judge error"}
    </div>
  );
}
