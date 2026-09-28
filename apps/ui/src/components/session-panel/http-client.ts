/**
 * Session panel — the API surface it needs, and a plain-`fetch` implementation
 * against the swarm HTTP API. Hosts pass their own base URL and auth, so the
 * panel does not depend on the dashboard's API client or config store.
 */

import type { SessionPanelDetail, SessionPanelListItem } from "./model";

export interface SessionPanelClient {
  /** Root sessions whose `contextKey` starts with `contextKeyPrefix`, newest activity first. */
  listSessions(query: {
    contextKeyPrefix: string;
    requestedByUserId?: string;
    limit?: number;
  }): Promise<SessionPanelListItem[]>;
  getSession(rootTaskId: string): Promise<SessionPanelDetail>;
  /** Root task for a new session. `contextKey` must be unique per session. */
  createSession(input: {
    task: string;
    contextKey: string;
    requestedByUserId?: string;
  }): Promise<{ id: string }>;
  /** Child task; it inherits the parent's `contextKey` server-side. */
  createFollowUp(input: {
    task: string;
    parentTaskId: string;
    requestedByUserId?: string;
  }): Promise<{ id: string }>;
  /** Queue a message into a running task. */
  steer(taskId: string, input: { message: string; requestedByUserId?: string }): Promise<void>;
}

export interface SessionPanelHttpClientOptions {
  /** Swarm API origin, e.g. `https://api.example.com`. `""` means same origin. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <apiKey>`. */
  apiKey?: string;
  /** Extra headers per request (overrides the defaults). */
  headers?: () => Record<string, string>;
  /** Task `source` for created tasks and the session list filter. Defaults to `ui`. */
  source?: string;
  fetch?: typeof fetch;
}

async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  return body?.error || `${fallback} (${res.status})`;
}

export function createSessionPanelHttpClient(
  options: SessionPanelHttpClientOptions,
): SessionPanelClient {
  const source = options.source ?? "ui";
  const base = options.baseUrl.replace(/\/+$/, "");

  async function request<T>(path: string, init: RequestInit, failure: string): Promise<T> {
    const doFetch = options.fetch ?? fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (options.apiKey) headers.Authorization = `Bearer ${options.apiKey}`;
    Object.assign(headers, options.headers?.());
    const res = await doFetch(`${base}${path}`, { ...init, headers });
    if (!res.ok) throw new Error(await errorMessage(res, failure));
    return (await res.json()) as T;
  }

  return {
    async listSessions({ contextKeyPrefix, requestedByUserId, limit = 20 }) {
      const params = new URLSearchParams({ source, contextKeyPrefix, limit: String(limit) });
      if (requestedByUserId) params.set("requestedByUserId", requestedByUserId);
      const data = await request<{ sessions: SessionPanelListItem[] }>(
        `/api/sessions?${params}`,
        { method: "GET" },
        "Failed to list sessions",
      );
      return data.sessions;
    },

    getSession(rootTaskId) {
      return request<SessionPanelDetail>(
        `/api/sessions/${encodeURIComponent(rootTaskId)}`,
        { method: "GET" },
        "Failed to load session",
      );
    },

    createSession({ task, contextKey, requestedByUserId }) {
      return request<{ id: string }>(
        "/api/tasks",
        { method: "POST", body: JSON.stringify({ task, contextKey, requestedByUserId, source }) },
        "Failed to start session",
      );
    },

    createFollowUp({ task, parentTaskId, requestedByUserId }) {
      return request<{ id: string }>(
        "/api/tasks",
        { method: "POST", body: JSON.stringify({ task, parentTaskId, requestedByUserId, source }) },
        "Failed to send message",
      );
    },

    async steer(taskId, { message, requestedByUserId }) {
      await request<unknown>(
        `/api/tasks/${encodeURIComponent(taskId)}/steer`,
        {
          method: "POST",
          body: JSON.stringify({ message, mode: "queue", requestedByUserId, source }),
        },
        "Failed to send message",
      );
    },
  };
}
