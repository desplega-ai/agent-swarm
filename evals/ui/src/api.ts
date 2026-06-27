import type {
  AnalyticsResponse,
  AttemptDetail,
  AttemptJson,
  AttemptProgressResponse,
  AttemptTasksResponse,
  ConfigJson,
  CreateRunBody,
  JudgeLiveResponse,
  ModelsResponse,
  PresetJson,
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
 * Per-task records (v7.5 items 2/5/6 — frozen contract, see AttemptTasksResponse).
 * `live: true` asks the server to read the still-running stack (same pattern as
 * the live transcript); it falls back to the stored artifacts on any failure.
 */
export function getAttemptTasks(
  attemptId: string,
  opts?: { live?: boolean },
): Promise<AttemptTasksResponse> {
  const qs = opts?.live ? "?live=1" : "";
  return request(`/api/attempts/${encodeURIComponent(attemptId)}/tasks${qs}`);
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

/**
 * Scenario detail. v7 §5.2: unknown/removed scenario ids return 200 with
 * `scenario: null` + `scenarioId` (historical attempts still listed) instead
 * of a 404 — the detail page renders an unregistered-scenario fallback.
 */
export function getScenario(
  id: string,
): Promise<{ scenario: ScenarioJson | null; scenarioId?: string; recentAttempts: AttemptJson[] }> {
  return request(`/api/scenarios/${encodeURIComponent(id)}`);
}

export function listConfigs(): Promise<ConfigJson[]> {
  return request("/api/configs");
}

/** Quick-run config presets (v7.7 item 1 — frozen contract, see PresetJson). */
export function listPresets(): Promise<PresetJson[]> {
  return request("/api/presets");
}

export function getModels(): Promise<ModelsResponse> {
  return request("/api/models");
}

/**
 * Pre-aggregated analytics (v5 spec §1). v7.6 §C3: optional global filter —
 * serialized as CSV query params (`harnesses`, `configs`), omitted when
 * empty/absent. The server filters source rows BEFORE aggregation and echoes
 * `appliedFilter`; `filterOptions` always carries the pre-filter option lists.
 */
export function getAnalytics(filter?: {
  harnesses?: string[];
  configIds?: string[];
}): Promise<AnalyticsResponse> {
  const params = new URLSearchParams();
  if (filter?.harnesses !== undefined && filter.harnesses.length > 0) {
    params.set("harnesses", filter.harnesses.join(","));
  }
  if (filter?.configIds !== undefined && filter.configIds.length > 0) {
    params.set("configs", filter.configIds.join(","));
  }
  const qs = params.size > 0 ? `?${params.toString()}` : "";
  return request(`/api/analytics${qs}`);
}

export function artifactUrl(id: string, opts?: { download?: boolean }): string {
  return `/api/artifacts/${encodeURIComponent(id)}${opts?.download ? "?download=1" : ""}`;
}
