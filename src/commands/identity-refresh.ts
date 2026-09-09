/**
 * Per-task DB → prompt refresh. Like skills-refresh, transient API failures keep
 * the cached identity. Workspace files and profile-sync baselines remain owned
 * by boot/session sync: rewriting them here could clobber an active local task.
 */

/** The identity-derived prompt inputs the runner caches at boot. */
export interface IdentityProfileFields {
  soulMd?: string;
  identityMd?: string;
  toolsMd?: string;
  claudeMd?: string;
  heartbeatMd?: string;
  name?: string;
  description?: string;
}

export type IdentityField = keyof IdentityProfileFields;

const IDENTITY_FIELDS: readonly IdentityField[] = [
  "soulMd",
  "identityMd",
  "toolsMd",
  "claudeMd",
  "heartbeatMd",
  "name",
  "description",
];

export interface IdentityRefreshContext {
  apiUrl: string;
  apiKey: string;
  agentId: string;
  role: string;
  /** Injectable to exercise network failures without a live API. */
  fetchImpl?: typeof fetch;
  /** Bounds both response headers and body consumption. */
  timeoutMs?: number;
}

export interface IdentityRefreshResult {
  changed: boolean;
  fields: IdentityProfileFields;
  changedFields: IdentityField[];
}

/**
 * One full /me read per task avoids a new signature API/cache protocol. Never
 * throws: a failed, malformed, or slow read leaves the last good prompt intact.
 * Only omitted fields preserve cached values; an empty string clears a field.
 */
export async function refreshIdentityIfChanged(
  ctx: IdentityRefreshContext,
  cached: IdentityProfileFields,
): Promise<IdentityRefreshResult> {
  const unchanged: IdentityRefreshResult = { changed: false, fields: cached, changedFields: [] };
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = async (): Promise<IdentityRefreshResult> => {
      const headers: Record<string, string> = { "X-Agent-ID": ctx.agentId };
      if (ctx.apiKey) headers.Authorization = `Bearer ${ctx.apiKey}`;
      const resp = await (ctx.fetchImpl ?? fetch)(`${ctx.apiUrl}/me`, {
        headers,
        signal: controller.signal,
      });
      if (!resp.ok) return unchanged;
      const fetched: unknown = await resp.json();
      if (!fetched || typeof fetched !== "object" || Array.isArray(fetched)) return unchanged;

      const payload = fetched as Record<string, unknown>;
      const fields: IdentityProfileFields = { ...cached };
      const changedFields: IdentityField[] = [];
      for (const field of IDENTITY_FIELDS) {
        if (!Object.hasOwn(payload, field)) continue;
        const value: unknown = payload[field];
        if (value === undefined) continue;
        if (typeof value !== "string") return unchanged;
        if (value !== cached[field]) {
          fields[field] = value;
          changedFields.push(field);
        }
      }
      return changedFields.length ? { changed: true, fields, changedFields } : unchanged;
    };

    // Race as well as abort: even a transport/body reader that ignores the
    // signal must not strand a task that the poll endpoint already claimed.
    const deadline = new Promise<IdentityRefreshResult>((resolve) => {
      timer = setTimeout(() => {
        resolve(unchanged);
        controller.abort();
      }, ctx.timeoutMs ?? 2_000);
    });
    return await Promise.race([read(), deadline]);
  } catch {
    return unchanged;
  } finally {
    clearTimeout(timer);
  }
}
