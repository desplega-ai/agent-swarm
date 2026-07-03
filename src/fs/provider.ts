import type {
  CommentableFileStorageProvider,
  ProviderCapabilities,
  SearchableFileStorageProvider,
  VersionedFileStorageProvider,
} from "./capabilities";

export type FilesErrorCode = "NotFound" | "Unauthorized" | "Conflict" | "ReadOnly" | "Provider";

export class FilesError extends Error {
  readonly code: FilesErrorCode;
  readonly status?: number;
  override readonly cause?: unknown;

  constructor(
    code: FilesErrorCode,
    message: string,
    opts: { status?: number; cause?: unknown } = {},
  ) {
    super(message);
    this.name = "FilesError";
    this.code = code;
    this.status = opts.status;
    this.cause = opts.cause;
  }
}

export type FileScope = {
  taskId: string;
  name: string;
  // Explicit provider storage key. When set, providers resolve THIS key verbatim
  // instead of deriving `tasks/<taskId>/<name>`. Existing attachments were written
  // to agent-fs at arbitrary paths (e.g. `misc/…`, `smoke/…`) via the CLI, so
  // reconstructing from taskId+name mis-resolves them. New uploads leave this
  // unset and keep the forward-looking `tasks/<taskId>/…` layout.
  key?: string;
  // Per-attachment agent-fs org/drive override. Older rows recorded their own
  // org/drive; fall back to the provider's configured shared org/drive when unset.
  orgId?: string;
  driveId?: string;
};

export type FileBody = NonNullable<RequestInit["body"]>;

export type UploadOptions = {
  contentType?: string;
  sizeBytes?: number;
  ifNoneMatch?: "*" | string;
  ifMatch?: string;
  message?: string;
  metadata?: Record<string, string>;
};

export type FileObject = {
  providerId: string;
  key: string;
  taskId: string;
  name: string;
  contentType?: string;
  sizeBytes?: number;
  etag?: string;
  sha256?: string;
  version?: string;
  updatedAt?: string;
  metadata?: Record<string, unknown>;
};

export type FileListOptions = {
  taskId: string;
  prefix?: string;
  limit?: number;
};

export type SignedUrlOptions = {
  expiresIn?: number;
};

export type FileStorageProvider = {
  readonly id: string;
  readonly capabilities: ProviderCapabilities;

  upload(scope: FileScope, body: FileBody, options?: UploadOptions): Promise<FileObject>;
  download(scope: FileScope): Promise<Response>;
  head(scope: FileScope): Promise<FileObject>;
  exists(scope: FileScope): Promise<boolean>;
  delete(scope: FileScope): Promise<void>;
  copy(source: FileScope, destination: FileScope): Promise<FileObject>;
  move(source: FileScope, destination: FileScope): Promise<FileObject>;
  list(options: FileListOptions): Promise<FileObject[]>;
  listAll(options: FileListOptions): AsyncIterable<FileObject>;
  url(scope: FileScope, options?: SignedUrlOptions): Promise<string>;
  signedUploadUrl(scope: FileScope, options?: SignedUrlOptions): Promise<string>;
} & Partial<SearchableFileStorageProvider> &
  Partial<CommentableFileStorageProvider> &
  Partial<VersionedFileStorageProvider>;

export function providerPath(scope: FileScope): string {
  if (scope.key !== undefined && scope.key !== null && scope.key !== "") {
    return normalizeStoredKey(scope.key);
  }
  const safeName = normalizeName(scope.name);
  return `tasks/${encodeURIComponent(scope.taskId)}/${safeName}`;
}

// A stored provider key is already in the provider's canonical form (it came back
// from the provider at write time, or from the agent's own CLI path). Use it as-is
// except: drop leading slashes so it embeds cleanly in a URL/path, and reject the
// traversal shapes a path must never contain.
export function normalizeStoredKey(key: string): string {
  const trimmed = key.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed.includes("\0")) {
    throw new FilesError("Provider", "Stored file key must be a non-empty path");
  }
  if (trimmed.split("/").some((part) => part === "..")) {
    throw new FilesError("Provider", "Stored file key must not contain parent path segments");
  }
  return trimmed;
}

export function normalizeName(name: string): string {
  const trimmed = name.trim().replace(/^\/+/, "");
  if (!trimmed || trimmed === "." || trimmed.includes("\0")) {
    throw new FilesError("Provider", "File name must be a non-empty relative path");
  }

  const parts = trimmed.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new FilesError("Provider", "File name must not contain empty or parent path segments");
  }

  return parts.map(encodeURIComponent).join("/");
}

export function fileObjectFromHeaders(
  providerId: string,
  scope: FileScope,
  headers: Headers,
  overrides: Partial<FileObject> = {},
): FileObject {
  const sizeHeader = headers.get("content-length");
  return {
    providerId,
    key: providerPath(scope),
    taskId: scope.taskId,
    name: scope.name,
    contentType: headers.get("content-type") ?? undefined,
    sizeBytes: sizeHeader ? Number(sizeHeader) : undefined,
    etag: headers.get("etag") ?? undefined,
    sha256: headers.get("x-agent-fs-content-hash") ?? undefined,
    version: headers.get("x-agent-fs-version") ?? undefined,
    ...overrides,
  };
}

export function normalizeFilesError(error: unknown): FilesError {
  if (error instanceof FilesError) {
    return error;
  }
  return new FilesError(
    "Provider",
    error instanceof Error ? error.message : "File provider error",
    {
      cause: error,
    },
  );
}
