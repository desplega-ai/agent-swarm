import type { ScriptRunJournalEntry } from "@/api/types";

const METHOD_TO_TYPE: Record<string, string> = {
  swarmScript: "swarm-script",
  agentTask: "agent-task",
  rawLlm: "raw-llm",
  humanInTheLoop: "human-in-the-loop",
};

export interface StepBlock {
  /** The ctx.step.* method (swarmScript | agentTask | rawLlm | humanInTheLoop). */
  method: string;
  /** Journal stepType this block produces (swarm-script | agent-task | raw-llm). */
  stepType: string;
  /** 0-based first line of the call statement. */
  startLine: number;
  /** 0-based last line (inclusive) — spans multi-line config objects. */
  endLine: number;
  /** Raw first-argument text (the step label expression). */
  labelRaw: string;
  /** Does a given runtime stepKey originate from this call site? */
  matches: (stepKey: string) => boolean;
}

/**
 * Derive a stepKey matcher from the label expression:
 * - string literal `"foo"` → exact match
 * - template literal `` `step-${i}` `` → regex from the static segments (handles loops)
 * - anything else (a bare variable) → matches nothing (falls back to type heuristics)
 */
function buildMatcher(labelRaw: string): (stepKey: string) => boolean {
  const t = labelRaw.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const literal = t.slice(1, -1);
    return (k) => k === literal;
  }
  if (t.startsWith("`") && t.endsWith("`")) {
    const inner = t.slice(1, -1);
    const segments = inner
      .split(/\$\{[^}]*\}/g)
      .map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
    try {
      const re = new RegExp(`^${segments.join(".*")}$`);
      return (k) => re.test(k);
    } catch {
      return () => false;
    }
  }
  return () => false;
}

/**
 * Build a `lineOf(charIndex) → 0-based line` lookup for `source`. Scans newlines
 * once into a sorted `lineStarts` array, then answers each query with a binary
 * search. Shared by both source parsers so the indexing logic lives in one place.
 */
function lineIndexer(source: string): (idx: number) => number {
  const lineStarts = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") lineStarts.push(i + 1);
  }
  return (idx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (lineStarts[mid] <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
}

/** Is the char at `i` escaped? Counts consecutive preceding backslashes (odd = escaped). */
function isEscaped(src: string, i: number): boolean {
  let n = 0;
  let j = i - 1;
  while (j >= 0 && src[j] === "\\") {
    n++;
    j--;
  }
  return n % 2 === 1;
}

/** Find every `ctx.step.<method>(...)` call site in the source and its line span. */
export function parseStepBlocks(source: string): StepBlock[] {
  const blocks: StepBlock[] = [];
  const re = /ctx\s*\.\s*step\s*\.\s*(swarmScript|agentTask|rawLlm|humanInTheLoop)\s*\(/g;
  const lineOf = lineIndexer(source);

  let m: RegExpExecArray | null = re.exec(source);
  while (m !== null) {
    const method = m[1];
    const openParen = re.lastIndex - 1;
    let depth = 0;
    let firstArgEnd = -1;
    let endIdx = -1;
    let inStr: string | null = null;
    for (let i = openParen; i < source.length; i++) {
      const c = source[i];
      if (inStr) {
        if (c === inStr && !isEscaped(source, i)) inStr = null;
        continue;
      }
      if (c === '"' || c === "'" || c === "`") inStr = c;
      else if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) {
          endIdx = i;
          break;
        }
      } else if (c === "," && depth === 1 && firstArgEnd === -1) firstArgEnd = i;
    }
    if (endIdx !== -1) {
      const labelRaw = source
        .slice(openParen + 1, firstArgEnd === -1 ? endIdx : firstArgEnd)
        .trim();
      blocks.push({
        method,
        stepType: METHOD_TO_TYPE[method] ?? method,
        startLine: lineOf(m.index),
        endLine: lineOf(endIdx),
        labelRaw,
        matches: buildMatcher(labelRaw),
      });
    }
    m = re.exec(source);
  }
  return blocks;
}

export interface StepBlockMapping {
  /** stepId → block index. */
  stepToBlock: Record<string, number>;
  /** block index → stepIds produced by it (in journal order). */
  blockToStepIds: Record<number, string[]>;
}

/** What the user has focused — a journal step, the run input (args), or the run output (return). */
export type Selection =
  | { kind: "step"; stepId: string }
  | { kind: "input" }
  | { kind: "output" }
  | null;

export interface SourceAnchor {
  startLine: number;
  endLine: number;
}

export interface RunAnchors {
  /** The `main(args, …)` signature line — maps to the run's args. */
  input: SourceAnchor | null;
  /** The script's final `return` line — maps to the run's output. */
  output: SourceAnchor | null;
}

/** Locate the source lines that correspond to the run's input (args) and output (return). */
export function parseRunAnchors(source: string): RunAnchors {
  const lineOf = lineIndexer(source);

  const sig =
    /^[^\n]*\bmain\b[^\n]*\(/m.exec(source) ?? /^[^\n]*\bfunction\b[^\n]*\(/m.exec(source);
  const input = sig ? { startLine: lineOf(sig.index), endLine: lineOf(sig.index) } : null;

  const returnRe = /\breturn\b/g;
  let lastReturn = -1;
  let rm: RegExpExecArray | null = returnRe.exec(source);
  while (rm !== null) {
    lastReturn = rm.index;
    rm = returnRe.exec(source);
  }
  const output =
    lastReturn >= 0 ? { startLine: lineOf(lastReturn), endLine: lineOf(lastReturn) } : null;

  return { input, output };
}

/** Attribute each journal step to the call site that produced it. */
export function mapStepsToBlocks(
  journal: ScriptRunJournalEntry[],
  blocks: StepBlock[],
): StepBlockMapping {
  const stepToBlock: Record<string, number> = {};
  const blockToStepIds: Record<number, string[]> = {};

  for (const entry of journal) {
    let idx = blocks.findIndex((b) => b.stepType === entry.stepType && b.matches(entry.stepKey));
    if (idx === -1) {
      // Fallback: exactly one call site of this type → unambiguous attribution.
      const sameType = blocks.flatMap((b, i) => (b.stepType === entry.stepType ? [i] : []));
      if (sameType.length === 1) idx = sameType[0];
    }
    if (idx !== -1) {
      stepToBlock[entry.id] = idx;
      if (!blockToStepIds[idx]) blockToStepIds[idx] = [];
      blockToStepIds[idx].push(entry.id);
    }
  }
  return { stepToBlock, blockToStepIds };
}
