import type {
  AnalyticsResponse,
  AttemptDetail,
  AttemptJson,
  AttemptProgressResponse,
  ConfigJson,
  CreateRunBody,
  JudgeLiveResponse,
  ModelsResponse,
  RunDetail,
  RunListItem,
  ScenarioJson,
  TranscriptResponse,
} from "./types.ts";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  if (!res.ok) {
    let message = `${res.status} ${res.statusText}`;
    try {
      const body: unknown = await res.json();
      if (
        body &&
        typeof body === "object" &&
        "error" in body &&
        typeof (body as { error: unknown }).error === "string"
      ) {
        message = (body as { error: string }).error;
      }
    } catch {
      // non-JSON error body — keep the status line
    }
    throw new Error(message);
  }
  return (await res.json()) as T;
}

export function listRuns(): Promise<RunListItem[]> {
  return request("/api/runs");
}

export function getRun(id: string): Promise<RunDetail> {
  return request(`/api/runs/${encodeURIComponent(id)}`);
}

export function createRun(body: CreateRunBody): Promise<{ runId: string }> {
  return request("/api/runs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function resumeRun(id: string): Promise<void> {
  await request(`/api/runs/${encodeURIComponent(id)}/resume`, { method: "POST" });
}

export async function cancelRun(id: string): Promise<void> {
  await request(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" });
}

export function getAttempt(id: string): Promise<AttemptDetail> {
  return request(`/api/attempts/${encodeURIComponent(id)}`);
}

export function getTranscript(
  attemptId: string,
  opts?: { live?: boolean },
): Promise<TranscriptResponse> {
  const qs = opts?.live ? "?live=1" : "";
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/transcript${qs}`);
}

/**
 * Live judge traces while an attempt is judging. Always 200; unknown/finished
 * attempts return { judging: false, traces: [] } — use persisted judgments then.
 */
export function getJudgeLive(attemptId: string): Promise<JudgeLiveResponse> {
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/judge-live`);
}

/**
 * Live runner progress while an attempt executes (v4 spec §3). Always 200;
 * unknown/finished attempts return { active: false, …empty } — use the
 * persisted timings + runner.log artifact then.
 */
export function getAttemptProgress(attemptId: string): Promise<AttemptProgressResponse> {
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/progress`);
}

export function listScenarios(): Promise<ScenarioJson[]> {
  return request("/api/scenarios");
}

export function getScenario(
  id: string,
): Promise<{ scenario: ScenarioJson; recentAttempts: AttemptJson[] }> {
  return request(`/api/scenarios/${encodeURIComponent(id)}`);
}

export function listConfigs(): Promise<ConfigJson[]> {
  return request("/api/configs");
}

export function getModels(): Promise<ModelsResponse> {
  return request("/api/models");
}

/** Pre-aggregated analytics (v5 spec §1 — implemented server-side by WP-AAPI). */
export function getAnalytics(): Promise<AnalyticsResponse> {
  return request("/api/analytics");
}

export function artifactUrl(id: string, opts?: { download?: boolean }): string {
  return `/api/artifacts/${encodeURIComponent(id)}${opts?.download ? "?download=1" : ""}`;
}
