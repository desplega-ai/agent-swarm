// Request composition: what each LLM call's prompt is made of. A session's
// manifest (`GET /api/tasks/{id}/request-composition`) lists the static parts
// the worker measured. Two more parts are derived here from the call's real
// prompt tokens:
//
// - harness base (unattributed): what the harness adds that we cannot see.
//   It is the session's first main call minus the static parts.
// - message history: the rest of call k, `P_k − static − harness base`.
//
// Relative imports only: `bun:test` runs this from the repo root.

import type { CallUsage, NormalizedItem } from "../logs-parser/types";

export type CompositionPartKind =
  | "system_section"
  | "persona"
  | "claude_md"
  | "operator_prompt"
  | "tool_schemas"
  | "skills_listing"
  | "task_prompt"
  | "memories";

/** Mirrors `RequestCompositionPartSchema` in the API's `src/types.ts`. */
export interface CompositionPart {
  kind: CompositionPartKind;
  id: string;
  label: string;
  chars: number;
  estTokens: number;
  fidelity: "exact" | "estimate";
}

/** Mirrors `RequestCompositionSchema` in the API's `src/types.ts`. */
export interface CompositionManifest {
  id: string;
  taskId: string;
  agentId: string;
  sessionId: string;
  seq: number;
  provider: string;
  model: string | null;
  source: "worker" | "harness-hook";
  parts: CompositionPart[];
  staticEstTokens: number;
  tokenRatio: number;
  createdAt: string;
}

/** The bar's segments, in display order. */
export type CompositionGroup =
  | "system"
  | "persona"
  | "tools"
  | "skills"
  | "task"
  | "harness"
  | "history";

export const COMPOSITION_GROUPS: { group: CompositionGroup; label: string }[] = [
  { group: "system", label: "System prompt" },
  { group: "persona", label: "Persona + CLAUDE.md" },
  { group: "tools", label: "Tool schemas" },
  { group: "skills", label: "Skills" },
  { group: "task", label: "Task prompt" },
  { group: "harness", label: "Harness base (unattributed)" },
  { group: "history", label: "Message history" },
];

const GROUP_OF_KIND: Record<CompositionPartKind, CompositionGroup> = {
  system_section: "system",
  operator_prompt: "system",
  persona: "persona",
  claude_md: "persona",
  tool_schemas: "tools",
  skills_listing: "skills",
  task_prompt: "task",
  memories: "task",
};

export function compositionGroupOf(kind: CompositionPartKind): CompositionGroup {
  return GROUP_OF_KIND[kind];
}

/** A part's tokens: its `chars / 4` estimate times the manifest's ratio. */
export function partTokens(part: CompositionPart, manifest: CompositionManifest): number {
  return part.estTokens * manifest.tokenRatio;
}

export function staticTokens(manifest: CompositionManifest): number {
  let sum = 0;
  for (const part of manifest.parts) sum += partTokens(part, manifest);
  return sum;
}

export interface CompositionSegment {
  group: CompositionGroup;
  tokens: number;
  /** Any part in it is an estimate, or it is derived (harness base, history). */
  estimate: boolean;
}

export interface CallComposition {
  callId: string;
  promptTokens: number;
  /** One per group with tokens, in `COMPOSITION_GROUPS` order. Sums to `promptTokens`. */
  segments: CompositionSegment[];
  /**
   * The static parts and harness base were larger than this call's prompt,
   * so they were scaled down to fit it. The estimates overshoot.
   */
  scaled: boolean;
  manifest: CompositionManifest;
}

/** One LLM call, placed in its session and time. */
export interface CompositionCall {
  usage: CallUsage;
  sessionId: string;
  /** Epoch ms. */
  t: number;
}

/** A compaction in a session. Epoch ms. */
export interface CompositionCompaction {
  sessionId: string;
  t: number;
}

/** The call a manifest's harness base is measured on. */
export interface CompositionAnchor {
  callId: string;
  promptTokens: number;
  residualTokens: number;
}

export interface DerivedCompositions {
  byCall: Map<string, CallComposition>;
  /** Per manifest id: the anchor call its harness base is measured on. */
  anchors: Map<string, CompositionAnchor>;
}

/** The session's manifest in force at `t`: the latest written by then, else the first. */
function manifestAt(manifests: CompositionManifest[], t: number): CompositionManifest | undefined {
  let chosen: CompositionManifest | undefined;
  for (const m of manifests) {
    const at = Date.parse(m.createdAt);
    if (Number.isFinite(at) && at <= t && (!chosen || m.seq > chosen.seq)) chosen = m;
  }
  if (chosen) return chosen;
  let first: CompositionManifest | undefined;
  for (const m of manifests) if (!first || m.seq < first.seq) first = m;
  return first;
}

function groupManifest(manifest: CompositionManifest): Map<CompositionGroup, CompositionSegment> {
  const groups = new Map<CompositionGroup, CompositionSegment>();
  for (const part of manifest.parts) {
    const group = compositionGroupOf(part.kind);
    const seg = groups.get(group) ?? { group, tokens: 0, estimate: false };
    seg.tokens += partTokens(part, manifest);
    seg.estimate ||= part.fidelity === "estimate";
    groups.set(group, seg);
  }
  return groups;
}

/**
 * Splits each main-thread call's prompt into the manifest's static parts, the
 * harness base and message history.
 *
 * - The harness base is measured on the session's first main call, the anchor.
 *   Sub-agent calls have their own prompt, so they are never an anchor and get
 *   no composition.
 * - A later harness-hook manifest (exact parts) re-splits the anchor's static
 *   parts and harness base, so history stays `P_k − P_anchor`. A later worker
 *   manifest keeps the harness base and swaps only the static parts.
 * - After a compaction, the first main call is a new anchor. Its harness base
 *   can shrink but never grow: the compaction summary is history, not harness.
 * - Nothing goes negative. When the static parts and harness base exceed a
 *   call's prompt, they are scaled down to fit and the call is marked `scaled`.
 */
export function deriveCallCompositions(
  calls: CompositionCall[],
  manifests: CompositionManifest[],
  compactions: CompositionCompaction[] = [],
): DerivedCompositions {
  const byCall = new Map<string, CallComposition>();
  const anchors = new Map<string, CompositionAnchor>();
  if (manifests.length === 0) return { byCall, anchors };

  const bySession = new Map<string, CompositionManifest[]>();
  for (const m of manifests) {
    const list = bySession.get(m.sessionId) ?? [];
    list.push(m);
    bySession.set(m.sessionId, list);
  }
  const compactionsBySession = new Map<string, number[]>();
  for (const c of compactions) {
    const list = compactionsBySession.get(c.sessionId) ?? [];
    list.push(c.t);
    compactionsBySession.set(c.sessionId, list);
  }

  // Per session: the current compaction epoch's anchor. `base` is the anchor
  // call's static parts plus harness base, the prompt with no history in it.
  const current = new Map<
    string,
    { manifestId: string; epoch: number; base: number; residual: number; anchor: CompositionAnchor }
  >();
  const ordered = calls
    .map((call, index) => ({ call, index }))
    .sort((a, b) => a.call.t - b.call.t || a.index - b.index);

  for (const { call } of ordered) {
    const { usage, sessionId, t } = call;
    if (usage.sidechain) continue;
    const manifest = manifestAt(bySession.get(sessionId) ?? [], t);
    if (!manifest) continue;

    const epoch = (compactionsBySession.get(sessionId) ?? []).filter((c) => c <= t).length;
    const stat = staticTokens(manifest);
    let state = current.get(sessionId);
    if (!state || state.epoch !== epoch) {
      let residual = Math.max(0, usage.promptTokens - stat);
      // New compaction epoch: the harness base can shrink, never grow.
      if (state) residual = Math.min(residual, Math.max(0, state.base - stat));
      const anchor = {
        callId: usage.callId,
        promptTokens: usage.promptTokens,
        residualTokens: residual,
      };
      state = {
        manifestId: manifest.id,
        epoch,
        base: Math.min(stat + residual, usage.promptTokens),
        residual,
        anchor,
      };
      current.set(sessionId, state);
      if (!anchors.has(manifest.id)) anchors.set(manifest.id, anchor);
    } else if (state.manifestId !== manifest.id) {
      // A later manifest in the same epoch. This call already carries
      // history, so it never becomes the anchor. A harness hook measures the
      // parts exactly, so it re-splits the anchor's base. A worker manifest
      // only re-estimates its static parts, so the harness base stays.
      const residual =
        manifest.source === "harness-hook" ? Math.max(0, state.base - stat) : state.residual;
      state = { ...state, manifestId: manifest.id, base: stat + residual, residual };
      current.set(sessionId, state);
      if (!anchors.has(manifest.id)) {
        anchors.set(manifest.id, { ...state.anchor, residualTokens: residual });
      }
    }

    const groups = groupManifest(manifest);
    groups.set("harness", { group: "harness", tokens: state.residual, estimate: true });
    const known = stat + state.residual;
    const prompt = usage.promptTokens;
    const scaled = known > prompt;
    const factor = scaled && known > 0 ? prompt / known : 1;
    groups.set("history", {
      group: "history",
      tokens: Math.max(0, prompt - known),
      estimate: true,
    });

    const segments: CompositionSegment[] = [];
    for (const { group } of COMPOSITION_GROUPS) {
      const seg = groups.get(group);
      if (!seg) continue;
      const tokens = group === "history" ? seg.tokens : seg.tokens * factor;
      if (tokens > 0) segments.push({ ...seg, tokens });
    }
    byCall.set(usage.callId, {
      callId: usage.callId,
      promptTokens: prompt,
      segments,
      scaled,
      manifest,
    });
  }
  return { byCall, anchors };
}

/** The `call_usage` items of a parsed session, placed in their session. */
export function compositionCallsOf(
  items: NormalizedItem[],
  sessionOfRecord: (recId: string) => string | undefined,
): CompositionCall[] {
  const calls: CompositionCall[] = [];
  for (const item of items) {
    if (item.kind !== "call_usage" || !item.usage) continue;
    const sessionId = sessionOfRecord(item.recId);
    if (sessionId) calls.push({ usage: item.usage, sessionId, t: item.t });
  }
  return calls;
}
