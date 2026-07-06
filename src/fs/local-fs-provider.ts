import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  type FileBody,
  type FileObject,
  type FileScope,
  type FileStorageProvider,
  FilesError,
  providerPath,
  type UploadOptions,
} from "./provider";

export type LocalFsProviderOptions = {
  rootDir?: string;
};

const DEFAULT_ROOT_DIR = "./data/fs";

export class LocalFsProvider implements FileStorageProvider {
  readonly id = "local-fs";
  readonly capabilities = {
    signedUrl: { supported: false },
  };

  private readonly rootDir: string;

  constructor(options: LocalFsProviderOptions = {}) {
    this.rootDir = options.rootDir ?? process.env.AGENT_FS_LOCAL_DIR ?? DEFAULT_ROOT_DIR;
  }

  async upload(scope: FileScope, body: FileBody, options: UploadOptions = {}): Promise<FileObject> {
    const target = this.localPath(scope);
    await mkdir(dirname(target), { recursive: true });

    if (options.ifNoneMatch === "*" && (await this.exists(scope))) {
      throw new FilesError("Conflict", "File already exists");
    }

    await Bun.write(target, await new Response(body).arrayBuffer());
    // Persist the real upload Content-Type alongside the blob — `Bun.file(target).type`
    // only guesses from the storage path's extension, which is wrong whenever the
    // stored key doesn't carry the original filename's extension (see head()).
    if (options.contentType) {
      await Bun.write(this.metaPath(target), JSON.stringify({ contentType: options.contentType }));
    }
    return this.head(scope);
  }

  async download(scope: FileScope): Promise<Response> {
    const target = this.localPath(scope);
    if (!(await this.exists(scope))) {
      throw new FilesError("NotFound", "File not found");
    }
    return new Response(Bun.file(target));
  }

  async head(scope: FileScope): Promise<FileObject> {
    const target = this.localPath(scope);
    try {
      const info = await stat(target);
      const storedContentType = await this.readStoredContentType(target);
      return {
        providerId: this.id,
        key: providerPath(scope),
        taskId: scope.taskId,
        name: scope.name,
        // Prefer the Content-Type recorded at upload time; fall back to
        // extension-based sniffing only for files that predate the sidecar
        // metadata (or were written directly on disk without going through upload()).
        contentType: storedContentType ?? Bun.file(target).type ?? undefined,
        sizeBytes: info.size,
        updatedAt: info.mtime.toISOString(),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new FilesError("NotFound", "File not found", { cause: error });
      }
      throw new FilesError("Provider", "Unable to read file metadata", { cause: error });
    }
  }

  async exists(scope: FileScope): Promise<boolean> {
    try {
      await stat(this.localPath(scope));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw new FilesError("Provider", "Unable to check file existence", { cause: error });
    }
  }

  async delete(scope: FileScope): Promise<void> {
    const target = this.localPath(scope);
    await rm(target, { force: true });
    await rm(this.metaPath(target), { force: true });
  }

  async copy(source: FileScope, destination: FileScope): Promise<FileObject> {
    const sourceHead = await this.head(source);
    const response = await this.download(source);
    await this.upload(destination, await response.arrayBuffer(), {
      contentType: sourceHead.contentType,
    });
    return this.head(destination);
  }

  async move(source: FileScope, destination: FileScope): Promise<FileObject> {
    const copied = await this.copy(source, destination);
    await this.delete(source);
    return copied;
  }

  async list(options: { taskId: string; prefix?: string; limit?: number }): Promise<FileObject[]> {
    const taskRoot = join(this.rootDir, "tasks", encodeURIComponent(options.taskId));
    const files: FileObject[] = [];
    await this.walk(taskRoot, async (path) => {
      const rel = relative(taskRoot, path).split(sep).join("/");
      const name = decodePath(rel);
      if (options.prefix && !name.startsWith(options.prefix)) {
        return;
      }
      files.push(await this.head({ taskId: options.taskId, name }));
    });
    return typeof options.limit === "number" ? files.slice(0, options.limit) : files;
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

  async url(scope: FileScope): Promise<string> {
    return `/api/fs/tasks/${encodeURIComponent(scope.taskId)}/files/${encodeURIComponent(scope.name)}/raw`;
  }

  async signedUploadUrl(): Promise<string> {
    throw new FilesError("ReadOnly", "local-fs does not support signed upload URLs");
  }

  private localPath(scope: FileScope): string {
    return join(this.rootDir, providerPath(scope));
  }

  private metaPath(target: string): string {
    return `${target}.meta.json`;
  }

  private async readStoredContentType(target: string): Promise<string | undefined> {
    try {
      const metaFile = Bun.file(this.metaPath(target));
      if (!(await metaFile.exists())) {
        return undefined;
      }
      const meta = await metaFile.json();
      return typeof meta?.contentType === "string" ? meta.contentType : undefined;
    } catch {
      return undefined;
    }
  }

  private async walk(dir: string, visit: (path: string) => Promise<void>): Promise<void> {
    let entries: import("node:fs").Dirent<string>[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return;
      }
      throw new FilesError("Provider", "Unable to list files", { cause: error });
    }

    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.walk(path, visit);
      } else if (entry.isFile() && !entry.name.endsWith(".meta.json")) {
        await visit(path);
      }
    }
  }
}

function decodePath(path: string): string {
  return path
    .split("/")
    .map((part) => decodeURIComponent(part))
    .join("/");
}
