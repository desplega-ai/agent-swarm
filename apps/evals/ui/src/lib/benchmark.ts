/**
 * Public benchmark snapshot, as `bun src/cli.ts publish` writes it (server-side
 * source of truth: apps/evals/src/benchmark.ts). The page reads it from the
 * unauthenticated `/api/public/benchmark/*` routes, never from live data.
 */

import type { CiBounds, FrontierResponse, LeaderboardResponse } from "./suite-analytics.ts";

/** The snapshot shape this page renders; a newer schema asks for a page update. */
export const SUPPORTED_SNAPSHOT_SCHEMA = 1;

export interface BenchmarkVersion {
  suiteVersion: string;
  /** `YYYY-MM-DD` of the publish; with `suiteVersion` it names one snapshot. */
  snapshot: string;
  publishedAt: string | null;
}

export interface BenchmarkIndex {
  /** One entry per published snapshot, newest first. */
  versions: BenchmarkVersion[];
  latest: string | null;
}

export interface PublishedScenario {
  id: string;
  version: number;
  name: string;
  description: string | null;
  kind: "single-agent" | "swarm" | "solo-baseline";
  baselineOf: string | null;
  workers: number;
  hasLead: boolean;
  systemPrompts: { member: string; prompt: string }[];
  tasks: { title: string; description: string; assignee: string; dependsOn: number[] }[];
  timeoutMs: number | null;
  budgetUsd: number | null;
  budgetMs: number | null;
  passThreshold: number;
  gates: string[];
  dimensions: {
    name: string;
    weight: number;
    checks: string[];
    judge: { kind: "llm" | "agentic"; model: string | null; rubric: string } | null;
  }[];
}

export interface PublishedConfig {
  configId: string;
  label: string | null;
  harness: string;
  model: string | null;
  modelAlias: string | null;
  resolvedModels: string[];
  reasoningEffort: string | null;
  envKeys: string[];
  apiVersions: string[];
  workerVersions: string[];
  e2bTemplates: string[];
}

export interface SwarmSoloComparison {
  swarmId: string;
  soloId: string;
  configId: string;
  swarm: {
    n: number;
    meanScore: number | null;
    meanTokens: number | null;
    meanAgentMs: number | null;
  };
  solo: {
    n: number;
    meanScore: number | null;
    meanTokens: number | null;
    meanAgentMs: number | null;
  };
  deltaScore: (CiBounds & { diff: number; significant: boolean }) | null;
  tokenMultiple: number | null;
  deltaAgentMs: number | null;
}

export interface BenchmarkSnapshot {
  schema: number;
  canary: string;
  suite: { id: string; version: string };
  publishedAt: string;
  run: {
    id: string;
    createdAt: string;
    finishedAt: string | null;
    attemptsPerCell: number;
    configIds: string[];
    judgeModel: string;
    harnessCommit: string | null;
  };
  minAttemptsPerCell: number;
  passThreshold: number;
  heldOutCount: number;
  scenarios: PublishedScenario[];
  configs: PublishedConfig[];
  frontier: FrontierResponse;
  leaderboard: LeaderboardResponse;
  swarmVsSolo: SwarmSoloComparison[];
  limitations: string[];
  methodology: string;
}

async function getJson<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${path}: HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

export function getBenchmarkIndex(): Promise<BenchmarkIndex> {
  return getJson<BenchmarkIndex>("/api/public/benchmark");
}

/** `snapshot` omitted = the newest snapshot of that suite version. */
export function getBenchmarkSnapshot(
  version: string,
  snapshot?: string | null,
): Promise<BenchmarkSnapshot> {
  const base = `/api/public/benchmark/${encodeURIComponent(version)}`;
  return getJson<BenchmarkSnapshot>(snapshot ? `${base}/${encodeURIComponent(snapshot)}` : base);
}
