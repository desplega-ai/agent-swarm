import type { ByteString, IFileSystem, InMemoryFs } from "just-bash";

/**
 * Metadata that one run's scratch may hold: pathnames, entries, and symlink
 * targets. InMemoryFs charges only file bodies against its byte limit, and
 * under quickjs this memory is in the API process. Each entry costs
 * ENTRY_BYTES plus 2 bytes per path character, so the budget also caps a run
 * at about 30,000 entries.
 */
export const SCRIPT_FS_MAX_METADATA_BYTES = 8 * 1024 * 1024;
/** Estimated fixed cost of one entry: its object, Map slot, mode, and Date. */
const ENTRY_BYTES = 256;
/** Linux PATH_MAX and NAME_MAX. */
export const SCRIPT_FS_MAX_PATH_LENGTH = 4096;
export const SCRIPT_FS_MAX_NAME_LENGTH = 255;

type ReadFileOptions = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOptions = Parameters<IFileSystem["writeFile"]>[2];
type FileContent = Parameters<IFileSystem["writeFile"]>[1];

/** A path that scratch must never hold, and the error that access to it raises. */
export type ReservedPath = { path: string; error: (path: string) => Error };

const entryBytes = (pathLength: number) => ENTRY_BYTES + 2 * pathLength;

/** Metadata that creating `path` can add: the entry and each parent that may not exist yet. */
function createBytes(path: string): number {
  let bytes = entryBytes(path.length);
  for (let slash = path.indexOf("/", 1); slash > 0; slash = path.indexOf("/", slash + 1)) {
    bytes += entryBytes(slash);
  }
  return bytes;
}

function nameTooLong(path: string): Error {
  const shown = path.length > 80 ? `${path.slice(0, 80)}...` : path;
  return new Error(`ENAMETOOLONG: name too long, '${shown}'`);
}

/**
 * The scratch base of the script filesystem: an InMemoryFs plus the limits that
 * it does not enforce. It charges metadata against
 * SCRIPT_FS_MAX_METADATA_BYTES, rejects names longer than Linux allows, and
 * keeps a reserved path (an unconfigured /afs) out of scratch, so a shell
 * write there fails instead of landing in memory. MountableFs passes it
 * normalized absolute paths.
 */
export class ScratchFs implements IFileSystem {
  private readonly inner: InMemoryFs;
  private readonly reserved: ReservedPath | undefined;
  /** Upper bound of the metadata held. Measured again when a charge would pass the budget. */
  private charged: number;
  /** getAllPaths does not show symlink targets, so they are charged once and never credited. */
  private targetBytes = 0;

  constructor(inner: InMemoryFs, reserved?: ReservedPath) {
    this.inner = inner;
    this.reserved = reserved;
    this.charged = this.measure();
  }

  private checked(path: string): string {
    const reserved = this.reserved;
    if (reserved && (path === reserved.path || path.startsWith(`${reserved.path}/`))) {
      throw reserved.error(path);
    }
    if (
      path.length > SCRIPT_FS_MAX_PATH_LENGTH ||
      path.split("/").some((name) => name.length > SCRIPT_FS_MAX_NAME_LENGTH)
    ) {
      throw nameTooLong(path);
    }
    return path;
  }

  private measure(): number {
    let bytes = this.targetBytes;
    for (const path of this.inner.getAllPaths()) bytes += entryBytes(path.length);
    return bytes;
  }

  private reserve(bytes: number): void {
    if (this.charged + bytes > SCRIPT_FS_MAX_METADATA_BYTES) this.charged = this.measure();
    if (this.charged + bytes > SCRIPT_FS_MAX_METADATA_BYTES) {
      throw new Error(
        `ENOSPC: scratch metadata limit exceeded (${SCRIPT_FS_MAX_METADATA_BYTES} bytes)`,
      );
    }
    this.charged += bytes;
  }

  /** Metadata that copying or moving `src` to `dest` can add: `dest`, its parents, and the subtree. */
  private copyBytes(src: string, dest: string): number {
    let bytes = createBytes(dest);
    const prefix = `${src}/`;
    for (const path of this.inner.getAllPaths()) {
      if (path.startsWith(prefix)) bytes += entryBytes(dest.length + path.length - src.length);
    }
    return bytes;
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<string> {
    return this.inner.readFile(this.checked(path), options);
  }

  async readFileBytes(path: string): Promise<ByteString> {
    return this.inner.readFileBytes(this.checked(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    return this.inner.readFileBuffer(this.checked(path));
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    this.reserve(createBytes(this.checked(path)));
    return this.inner.writeFile(path, content, options);
  }

  /** just-bash writes its default layout (/bin, /dev, /proc) through the sync methods. */
  writeFileSync(path: string, content: FileContent): void {
    this.reserve(createBytes(this.checked(path)));
    this.inner.writeFileSync(path, content);
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    this.reserve(createBytes(this.checked(path)));
    return this.inner.appendFile(path, content, options);
  }

  async exists(path: string): Promise<boolean> {
    try {
      return this.inner.exists(this.checked(path));
    } catch {
      return false;
    }
  }

  async stat(path: string) {
    return this.inner.stat(this.checked(path));
  }

  async lstat(path: string) {
    return this.inner.lstat(this.checked(path));
  }

  async mkdir(path: string, options?: Parameters<IFileSystem["mkdir"]>[1]): Promise<void> {
    this.reserve(createBytes(this.checked(path)));
    return this.inner.mkdir(path, options);
  }

  mkdirSync(path: string, options?: Parameters<IFileSystem["mkdir"]>[1]): void {
    this.reserve(createBytes(this.checked(path)));
    this.inner.mkdirSync(path, options);
  }

  async createExclusive(
    path: string,
    options: Parameters<InMemoryFs["createExclusive"]>[1],
  ): Promise<void> {
    this.checked(path);
    // InMemoryFs resolves symlinks in the parent, so the new entry's path can differ.
    const slash = path.lastIndexOf("/");
    const parent = slash > 0 ? path.slice(0, slash) : "/";
    const real = await this.inner.realpath(parent).catch(() => parent);
    this.reserve(createBytes(`${real === "/" ? "" : real}${path.slice(slash)}`));
    return this.inner.createExclusive(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    return this.inner.readdir(this.checked(path));
  }

  async rm(path: string, options?: Parameters<IFileSystem["rm"]>[1]): Promise<void> {
    return this.inner.rm(this.checked(path), options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]): Promise<void> {
    this.reserve(this.copyBytes(this.checked(src), this.checked(dest)));
    return this.inner.cp(src, dest, options);
  }

  async mv(src: string, dest: string): Promise<void> {
    this.reserve(this.copyBytes(this.checked(src), this.checked(dest)));
    return this.inner.mv(src, dest);
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  async chmod(path: string, mode: number): Promise<void> {
    return this.inner.chmod(this.checked(path), mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (target.length > SCRIPT_FS_MAX_PATH_LENGTH) throw nameTooLong(target);
    this.reserve(createBytes(this.checked(linkPath)) + 2 * target.length);
    await this.inner.symlink(target, linkPath);
    this.targetBytes += 2 * target.length;
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    this.checked(existingPath);
    this.reserve(createBytes(this.checked(newPath)));
    return this.inner.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    return this.inner.readlink(this.checked(path));
  }

  async realpath(path: string): Promise<string> {
    return this.inner.realpath(this.checked(path));
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    return this.inner.utimes(this.checked(path), atime, mtime);
  }
}
