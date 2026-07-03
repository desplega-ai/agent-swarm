export type ProviderCapabilities = {
  signedUrl: {
    supported: boolean;
    maxExpiresIn?: number;
  };
  search?: boolean;
  comments?: boolean;
  versioning?: boolean;
};

export type SearchQuery = {
  taskId: string;
  query: string;
  limit?: number;
};

export type SearchResult = {
  path: string;
  score?: number;
  excerpt?: string;
  metadata?: Record<string, unknown>;
};

export type SearchableFileStorageProvider = {
  search(query: SearchQuery): Promise<SearchResult[]>;
};

export type CommentInput = {
  taskId: string;
  name: string;
  body: string;
  range?: Record<string, unknown>;
};

export type FileComment = {
  id: string;
  body: string;
  createdAt?: string;
  author?: string;
  range?: Record<string, unknown>;
};

export type CommentableFileStorageProvider = {
  addComment(input: CommentInput): Promise<FileComment>;
  listComments(scope: { taskId: string; name: string }): Promise<FileComment[]>;
};

export type FileVersion = {
  version: string;
  path: string;
  createdAt?: string;
  message?: string;
  hash?: string;
};

export type VersionedFileStorageProvider = {
  listVersions(scope: { taskId: string; name: string }): Promise<FileVersion[]>;
  restoreVersion(scope: { taskId: string; name: string; version: string }): Promise<FileVersion>;
};
