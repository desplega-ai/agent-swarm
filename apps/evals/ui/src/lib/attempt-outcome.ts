import type { JudgmentJson } from "../types.ts";

/** A pass/fail check every attempt must clear before its dimensions count. */
export interface OutcomeGate {
  name: string;
  pass: boolean;
  /** The first line of the check's reasoning, cut to fit one line. */
  reason: string | null;
}

/** One weighted dimension of the score. */
export interface OutcomeDimension {
  name: string;
  weight: number;
  score: number | null;
  reason: string | null;
}

export type OutcomeVerdict = "passed" | "failed" | "error" | "cancelled" | "unfinished";

export interface AttemptOutcomeView {
  verdict: OutcomeVerdict;
  /** Gates first: a failed gate explains a failed attempt before any dimension does. */
  gates: OutcomeGate[];
  dimensions: OutcomeDimension[];
  /** Weighted mean of the dimension scores: sum(w * score) / sum(w). Null when none is scored. */
  aggregate: number | null;
}

const ONE_LINE_MAX = 160;

/** The first non-empty line of a reasoning text, cut to one line. Null when there is none. */
export function oneLine(text: string | null, max = ONE_LINE_MAX): string | null {
  if (text === null) return null;
  const first = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (first === undefined) return null;
  return first.length > max ? `${first.slice(0, max - 1).trimEnd()}…` : first;
}

export function outcomeVerdict(status: string): OutcomeVerdict {
  switch (status) {
    case "passed":
    case "failed":
    case "error":
    case "cancelled":
      return status;
    default:
      return "unfinished";
  }
}

/**
 * Split an attempt's judgments the way a reader wants them: gates first, then the
 * weighted dimensions. A judgment with no `dimension` is a gate (this also holds
 * for attempts recorded before dimensions existed, where every check is a gate).
 */
export function buildAttemptOutcome(status: string, judgments: JudgmentJson[]): AttemptOutcomeView {
  const gates: OutcomeGate[] = [];
  const dimensions: OutcomeDimension[] = [];
  for (const j of judgments) {
    if (j.dimension === null || j.weight === null) {
      gates.push({ name: j.name, pass: j.pass, reason: oneLine(j.reasoning) });
    } else {
      dimensions.push({
        name: j.dimension,
        weight: j.weight,
        score: j.score,
        reason: oneLine(j.reasoning),
      });
    }
  }
  let weightSum = 0;
  let weighted = 0;
  for (const d of dimensions) {
    if (d.score === null) continue;
    weightSum += d.weight;
    weighted += d.weight * d.score;
  }
  return {
    verdict: outcomeVerdict(status),
    gates,
    dimensions,
    aggregate: weightSum > 0 ? weighted / weightSum : null,
  };
}
