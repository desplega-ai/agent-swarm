import type { FileComment, FileVersion, SearchQuery, SearchResult } from "./capabilities";
import {
  type FileBody,
  type FileObject,
  type FileScope,
  type FileStorageProvider,
  FilesError,
  fileObjectFromHeaders,
  providerPath,
  type SignedUrlOptions,
  type UploadOptions,
} from "./provider";

export type AgentFsProviderOptions = {
  apiUrl?: string;
  apiKey?: string;
  orgId?: string;
  driveId?: string;
  fetchImpl?: typeof fetch;
};

const DEFAULT_AGENT_FS_REQUEST_TIMEOUT_MS = 20_000;

// Per-request deadline for agent-fs data-plane calls. Read at call time (not in
// the constructor) because the provider is memoized in the registry while
// `AGENT_FS_REQUEST_TIMEOUT_MS` can change on a swarm_config reload.
export function agentFsRequestTimeoutMs(): number {
  const parsed = Number(process.env.AGENT_FS_REQUEST_TIMEOUT_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_AGENT_FS_REQUEST_TIMEOUT_MS;
}

// Uploads get the base deadline plus a size allowance of 256 bytes per ms, a
// 250 KB/s floor for the slowest link we are willing to wait on. A 300 KB
// attachment buys 1.2 s, the 50 MiB cap buys about 205 s.
export function agentFsUploadTimeoutMs(sizeBytes: number): number {
  return agentFsRequestTimeoutMs() + Math.ceil(Math.max(sizeBytes, 0) / 256);
}

type AgentFsRawUploadResponse = {
  version?: string | number;
  path?: string;
  contentHash?: string;
  deduped?: boolean;
};

export class AgentFsProvider implements FileStorageProvider {
  readonly id = "agent-fs";
  readonly capabilities = {
    signedUrl: { supported: true, maxExpiresIn: 3600 },
    search: true,
    comments: true,
    versioning: true,
  };

  private readonly apiUrl: string;
  private readonly apiKey: string;
  private readonly orgId: string;
  private readonly driveId: string;
  private readonly fetchImpl: typeof fetch;

  constructor(options: AgentFsProviderOptions = {}) {
    this.apiUrl = stripTrailingSlash(options.apiUrl ?? process.env.AGENT_FS_API_URL ?? "");
    this.apiKey =
      options.apiKey ?? process.env.API_AGENT_FS_API_KEY ?? process.env.AGENT_FS_API_KEY ?? "";
    this.orgId =
      options.orgId ??
      process.env.AGENT_FS_DEFAULT_ORG_ID ??
      process.env.AGENT_FS_SHARED_ORG_ID ??
      "";
    this.driveId = options.driveId ?? process.env.AGENT_FS_DEFAULT_DRIVE_ID ?? "";
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch;

    if (!this.apiUrl || !this.apiKey || !this.orgId || !this.driveId) {
      throw new FilesError(
        "Provider",
        "AGENT_FS_API_URL, API_AGENT_FS_API_KEY or AGENT_FS_API_KEY, AGENT_FS_DEFAULT_ORG_ID, and AGENT_FS_DEFAULT_DRIVE_ID are required for the agent-fs provider",
      );
    }
  }

  async upload(scope: FileScope, body: FileBody, options: UploadOptions = {}): Promise<FileObject> {
    const headers = new Headers(this.authHeaders());
    if (options.contentType) {
      headers.set("content-type", options.contentType);
    }
    if (options.ifNoneMatch) {
      headers.set("if-none-match", options.ifNoneMatch);
    }
    if (options.ifMatch) {
      headers.set("if-match", options.ifMatch);
    }
    if (options.message) {
      headers.set("x-agent-fs-message", options.message);
    }

    const response = await this.fetchRaw(
      scope,
      { method: "PUT", headers, body },
      agentFsUploadTimeoutMs(options.sizeBytes ?? knownByteLength(body)),
    );
    const parsed = (await response.json().catch(() => ({}))) as AgentFsRawUploadResponse;
    return fileObjectFromHeaders(this.id, scope, response.headers, {
      key: parsed.path ?? providerPath(scope),
      version:
        parsed.version === undefined
          ? (response.headers.get("x-agent-fs-version") ?? undefined)
          : String(parsed.version),
      sha256: parsed.contentHash ?? response.headers.get("x-agent-fs-content-hash") ?? undefined,
      metadata: { deduped: parsed.deduped },
    });
  }

  async download(scope: FileScope): Promise<Response> {
    return this.fetchRaw(scope, { method: "GET", headers: this.authHeaders() });
  }

  async head(scope: FileScope): Promise<FileObject> {
    const response = await this.download(scope);
    await response.body?.cancel();
    return fileObjectFromHeaders(this.id, scope, response.headers);
  }

  async exists(scope: FileScope): Promise<boolean> {
    try {
      await this.head(scope);
      return true;
    } catch (error) {
      if (error instanceof FilesError && error.code === "NotFound") {
        return false;
      }
      throw error;
    }
  }

  async delete(scope: FileScope): Promise<void> {
    await this.ops({ op: "rm", path: providerPath(scope) }, scope);
  }

  async copy(source: FileScope, destination: FileScope): Promise<FileObject> {
    await this.ops({ op: "cp", path: providerPath(source), dest: providerPath(destination) });
    return this.head(destination);
  }

  async move(source: FileScope, destination: FileScope): Promise<FileObject> {
    await this.ops({ op: "mv", path: providerPath(source), dest: providerPath(destination) });
    return this.head(destination);
  }

  async list(options: { taskId: string; prefix?: string; limit?: number }): Promise<FileObject[]> {
    const prefix = `tasks/${encodeURIComponent(options.taskId)}/${options.prefix ?? ""}`;
    const result = await this.ops({ op: "ls", path: prefix });
    const resultRecord = asRecord(result);
    const entries = Array.isArray(result)
      ? result
      : Array.isArray(resultRecord?.entries)
        ? resultRecord.entries
        : [];
    return entries.slice(0, options.limit).map((entry: Record<string, unknown>) => {
      const key = String(entry.path ?? entry.name ?? "");
      const name = key.startsWith(`tasks/${encodeURIComponent(options.taskId)}/`)
        ? key.slice(`tasks/${encodeURIComponent(options.taskId)}/`.length)
        : key;
      return {
        providerId: this.id,
        key,
        taskId: options.taskId,
        name: decodeURIComponent(name),
        contentType: typeof entry.mimeType === "string" ? entry.mimeType : undefined,
        sizeBytes: typeof entry.size === "number" ? entry.size : undefined,
        version: entry.version === undefined ? undefined : String(entry.version),
      };
    });
  }

  async *listAll(options: {
    taskId: string;
    prefix?: string;
    limit?: number;
  }): AsyncIterable<FileObject> {
    for (const item of await this.list(options)) {
      yield item;
    }
  }

  async url(scope: FileScope, options: SignedUrlOptions = {}): Promise<string> {
    const expiresIn = Math.min(options.expiresIn ?? 3600, this.capabilities.signedUrl.maxExpiresIn);
    const result = await this.ops(
      { op: "signed-url", path: providerPath(scope), expiresIn },
      scope,
    );
    if (typeof result === "string") {
      return result;
    }
    const resultRecord = asRecord(result);
    if (typeof resultRecord?.url === "string") {
      return resultRecord.url;
    }
    throw new FilesError("Provider", "agent-fs signed-url op did not return a URL");
  }

  async signedUploadUrl(): Promise<string> {
    throw new FilesError("ReadOnly", "agent-fs does not support signed upload URLs");
  }

  async search(query: SearchQuery): Promise<SearchResult[]> {
    const result = await this.ops({
      op: "search",
      query: query.query,
      path: `tasks/${encodeURIComponent(query.taskId)}`,
      limit: query.limit,
    });
    return Array.isArray(result) ? (result as SearchResult[]) : [];
  }

  async addComment(input: {
    taskId: string;
    name: string;
    body: string;
    range?: Record<string, unknown>;
  }): Promise<FileComment> {
    return (await this.ops({
      op: "comment-add",
      path: providerPath(input),
      body: input.body,
      range: input.range,
    })) as FileComment;
  }

  async listComments(scope: FileScope): Promise<FileComment[]> {
    const result = await this.ops({ op: "comment-list", path: providerPath(scope) });
    return Array.isArray(result) ? (result as FileComment[]) : [];
  }

  async listVersions(scope: FileScope): Promise<FileVersion[]> {
    const result = await this.ops({ op: "log", path: providerPath(scope) });
    return Array.isArray(result) ? (result as FileVersion[]) : [];
  }

  async restoreVersion(scope: FileScope & { version: string }): Promise<FileVersion> {
    return (await this.ops({
      op: "revert",
      path: providerPath(scope),
      version: scope.version,
    })) as FileVersion;
  }

  private async fetchRaw(
    scope: FileScope,
    init: RequestInit,
    timeoutMs: number = agentFsRequestTimeoutMs(),
  ): Promise<Response> {
    const response = await this.fetchWithDeadline(this.rawUrl(scope), init, timeoutMs);
    if (!response.ok) {
      throw await responseToFilesError(response);
    }
    return response;
  }

  private async ops(body: Record<string, unknown>, scope?: FileScope): Promise<unknown> {
    const { orgId, driveId } = this.scopeFor(scope);
    const response = await this.fetchWithDeadline(
      `${this.apiUrl}/orgs/${encodeURIComponent(orgId)}/ops`,
      {
        method: "POST",
        headers: {
          ...this.authHeaders(),
          "content-type": "application/json",
        },
        body: JSON.stringify({ driveId, ...body }),
      },
      agentFsRequestTimeoutMs(),
    );
    if (!response.ok) {
      throw await responseToFilesError(response);
    }
    return response.json().catch(() => null);
  }

  // Every data-plane call carries a deadline so a stalled provider fails fast
  // instead of hanging the request that is waiting on it.
  //
  // The timer is cleared as soon as `fetchImpl` settles. `fetch` settles once
  // the request body is fully sent and the response headers have arrived, so a
  // PUT is covered end to end while a GET is only bounded to time-to-headers.
  // Response body streaming stays unbounded on purpose: `download` hands the
  // Response straight to the caller, which may stream a large file for a while.
  private async fetchWithDeadline(
    url: string,
    init: RequestInit,
    timeoutMs: number,
  ): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const signal = init.signal
      ? AbortSignal.any([init.signal, controller.signal])
      : controller.signal;
    try {
      return await this.fetchImpl(url, { ...init, signal });
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === "AbortError" || error.name === "TimeoutError")
      ) {
        throw new FilesError("Timeout", `agent-fs did not respond within ${timeoutMs} ms`, {
          cause: error,
        });
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  private rawUrl(scope: FileScope): string {
    const { orgId, driveId } = this.scopeFor(scope);
    return `${this.apiUrl}/orgs/${encodeURIComponent(orgId)}/drives/${encodeURIComponent(driveId)}/files/${providerPath(scope)}/raw`;
  }

  private scopeFor(scope?: FileScope): { orgId: string; driveId: string } {
    const orgId = scope?.orgId?.trim();
    const driveId = scope?.driveId?.trim();

    if (Boolean(orgId) !== Boolean(driveId)) {
      throw new FilesError(
        "Provider",
        "agent-fs file scope must include both orgId and driveId, or neither",
        { status: 400 },
      );
    }

    return orgId && driveId ? { orgId, driveId } : { orgId: this.orgId, driveId: this.driveId };
  }

  private authHeaders(): Record<string, string> {
    return { authorization: `Bearer ${this.apiKey}` };
  }
}

// `FileBody` is anything `RequestInit["body"]` accepts. Streams and FormData
// have no cheap size, so they fall back to 0 and get the base deadline only.
function knownByteLength(body: FileBody): number {
  if (ArrayBuffer.isView(body)) return body.byteLength;
  if (body instanceof ArrayBuffer) return body.byteLength;
  if (body instanceof Blob) return body.size;
  return 0;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function responseToFilesError(response: Response): Promise<FilesError> {
  const text = await response.text().catch(() => "");
  const message = text || `File provider returned HTTP ${response.status}`;
  if (response.status === 401 || response.status === 403) {
    return new FilesError("Unauthorized", message, { status: response.status });
  }
  if (response.status === 404) {
    return new FilesError("NotFound", message, { status: response.status });
  }
  if (response.status === 409 || response.status === 412) {
    return new FilesError("Conflict", message, { status: response.status });
  }
  return new FilesError("Provider", message, { status: response.status });
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
