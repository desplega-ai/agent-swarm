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
/** Linux PATH_MAX, NAME_MAX, and MAXSYMLINKS. */
export const SCRIPT_FS_MAX_PATH_LENGTH = 4096;
export const SCRIPT_FS_MAX_NAME_LENGTH = 255;
const MAX_SYMLINK_HOPS = 40;

type ReadFileOptions = Parameters<IFileSystem["readFile"]>[1];
type WriteFileOptions = Parameters<IFileSystem["writeFile"]>[2];
type FileContent = Parameters<IFileSystem["writeFile"]>[1];

/** A path that scratch must never hold or reach, and the error that access to it raises. */
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
 * SCRIPT_FS_MAX_METADATA_BYTES and rejects names longer than Linux allows.
 *
 * It also keeps the reserved path (/afs) out of scratch. MountableFs routes
 * literal /afs paths to the drive, or here when there is no drive, but a
 * scratch symlink or a cp / mv into `/` can still reach /afs inside scratch.
 * So every operation checks the path after it follows symlinks, and cp / mv
 * check every path they will create before they start.
 */
export class ScratchFs implements IFileSystem {
  private readonly inner: InMemoryFs;
  private readonly reserved: ReservedPath;
  /** Upper bound of the metadata held. Measured again when a charge would pass the budget. */
  private charged: number;
  /**
   * Paths that may hold a symlink, because getAllPaths does not show symlink
   * targets. A superset: measure() drops the paths that no longer do.
   */
  private readonly links = new Set<string>();

  constructor(inner: InMemoryFs, reserved: ReservedPath) {
    this.inner = inner;
    this.reserved = reserved;
    this.charged = this.entryTotal();
  }

  private isReserved(path: string): boolean {
    return path === this.reserved.path || path.startsWith(`${this.reserved.path}/`);
  }

  /** Rejects a path that is reserved as written, or longer than Linux allows. */
  private checked(path: string): string {
    if (this.isReserved(path)) throw this.reserved.error(path);
    if (
      path.length > SCRIPT_FS_MAX_PATH_LENGTH ||
      path.split("/").some((name) => name.length > SCRIPT_FS_MAX_NAME_LENGTH)
    ) {
      throw nameTooLong(path);
    }
    return path;
  }

  /**
   * The path that `path` names after it follows symlinks, as a reader sees it.
   * With `followLast` false, a symlink in the last place stays (rm, lstat).
   * The part after the first missing name stays as written.
   */
  private async resolve(path: string, followLast: boolean): Promise<string> {
    let names = path.split("/").filter(Boolean);
    let current = "";
    let hops = 0;
    for (let i = 0; i < names.length; i++) {
      const next = `${current}/${names[i]}`;
      if (i === names.length - 1 && !followLast) return next;
      const stat = await this.inner.lstat(next).catch(() => undefined);
      if (!stat) return [next, ...names.slice(i + 1)].join("/");
      if (!stat.isSymbolicLink) {
        current = next;
        continue;
      }
      if (++hops > MAX_SYMLINK_HOPS) {
        throw new Error(`ELOOP: too many levels of symbolic links, '${path}'`);
      }
      const target = await this.inner.readlink(next);
      const joined = target.startsWith("/") ? target : `${current}/${target}`;
      const rest = names.slice(i + 1).join("/");
      names = this.inner
        .resolvePath("/", rest ? `${joined}/${rest}` : joined)
        .split("/")
        .filter(Boolean);
      current = "";
      i = -1;
    }
    return current || "/";
  }

  /** Checks `path` as written and as resolved. Returns the resolved path. */
  private async guard(path: string, followLast = true): Promise<string> {
    const real = await this.resolve(this.checked(path), followLast);
    if (this.isReserved(real)) throw this.reserved.error(path);
    return real;
  }

  private entryTotal(): number {
    let bytes = 0;
    for (const path of this.inner.getAllPaths()) bytes += entryBytes(path.length);
    return bytes;
  }

  private async measure(): Promise<number> {
    let bytes = this.entryTotal();
    for (const path of this.links) {
      const target = await this.inner.readlink(path).catch(() => undefined);
      if (target === undefined) this.links.delete(path);
      else bytes += 2 * target.length;
    }
    return bytes;
  }

  private async reserve(bytes: number): Promise<void> {
    if (this.charged + bytes > SCRIPT_FS_MAX_METADATA_BYTES) this.charged = await this.measure();
    this.charge(bytes);
  }

  private charge(bytes: number): void {
    if (this.charged + bytes > SCRIPT_FS_MAX_METADATA_BYTES) {
      throw new Error(
        `ENOSPC: scratch metadata limit exceeded (${SCRIPT_FS_MAX_METADATA_BYTES} bytes)`,
      );
    }
    this.charged += bytes;
  }

  /**
   * Checks every path that copying or moving `src` to `dest` creates, before
   * InMemoryFs starts: its recursion does not come back through this class.
   * Returns the metadata those paths can add.
   */
  private async preflightCopy(src: string, dest: string): Promise<number> {
    await this.guard(src, false);
    await this.guard(dest);
    let bytes = createBytes(dest);
    const prefix = `${src}/`;
    for (const path of this.inner.getAllPaths()) {
      if (!path.startsWith(prefix)) continue;
      const created = dest + path.slice(src.length);
      await this.guard(created);
      bytes += entryBytes(created.length);
    }
    return bytes;
  }

  /** Symlinks under `src` now (also) live under `dest`. */
  private copyLinks(src: string, dest: string): void {
    for (const path of [...this.links]) {
      if (path === src || path.startsWith(`${src}/`)) this.links.add(dest + path.slice(src.length));
    }
  }

  async readFile(path: string, options?: ReadFileOptions): Promise<string> {
    await this.guard(path);
    return this.inner.readFile(path, options);
  }

  async readFileBytes(path: string): Promise<ByteString> {
    await this.guard(path);
    return this.inner.readFileBytes(path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    await this.guard(path);
    return this.inner.readFileBuffer(path);
  }

  async writeFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    await this.guard(path);
    await this.reserve(createBytes(path));
    return this.inner.writeFile(path, content, options);
  }

  /** just-bash writes its default layout (/bin, /dev, /proc) through the sync methods. */
  writeFileSync(path: string, content: FileContent): void {
    this.charge(createBytes(this.checked(path)));
    this.inner.writeFileSync(path, content);
  }

  async appendFile(path: string, content: FileContent, options?: WriteFileOptions): Promise<void> {
    await this.guard(path);
    await this.reserve(createBytes(path));
    return this.inner.appendFile(path, content, options);
  }

  async exists(path: string): Promise<boolean> {
    try {
      await this.guard(path);
    } catch {
      return false;
    }
    return this.inner.exists(path);
  }

  async stat(path: string) {
    await this.guard(path);
    return this.inner.stat(path);
  }

  async lstat(path: string) {
    await this.guard(path, false);
    return this.inner.lstat(path);
  }

  async mkdir(path: string, options?: Parameters<IFileSystem["mkdir"]>[1]): Promise<void> {
    await this.guard(path);
    await this.reserve(createBytes(path));
    return this.inner.mkdir(path, options);
  }

  mkdirSync(path: string, options?: Parameters<IFileSystem["mkdir"]>[1]): void {
    this.charge(createBytes(this.checked(path)));
    this.inner.mkdirSync(path, options);
  }

  async createExclusive(
    path: string,
    options: Parameters<InMemoryFs["createExclusive"]>[1],
  ): Promise<void> {
    // InMemoryFs follows symlinks in the parent, so the entry lands at the resolved path.
    await this.reserve(createBytes(await this.guard(path, false)));
    return this.inner.createExclusive(path, options);
  }

  async readdir(path: string): Promise<string[]> {
    await this.guard(path);
    return this.inner.readdir(path);
  }

  async rm(path: string, options?: Parameters<IFileSystem["rm"]>[1]): Promise<void> {
    await this.guard(path, false);
    return this.inner.rm(path, options);
  }

  async cp(src: string, dest: string, options?: Parameters<IFileSystem["cp"]>[2]): Promise<void> {
    await this.reserve(await this.preflightCopy(src, dest));
    try {
      await this.inner.cp(src, dest, options);
    } finally {
      this.copyLinks(src, dest);
    }
  }

  async mv(src: string, dest: string): Promise<void> {
    await this.reserve(await this.preflightCopy(src, dest));
    try {
      await this.inner.mv(src, dest);
    } finally {
      this.copyLinks(src, dest);
    }
  }

  resolvePath(base: string, path: string): string {
    return this.inner.resolvePath(base, path);
  }

  getAllPaths(): string[] {
    return this.inner.getAllPaths();
  }

  async chmod(path: string, mode: number): Promise<void> {
    await this.guard(path, false);
    return this.inner.chmod(path, mode);
  }

  async symlink(target: string, linkPath: string): Promise<void> {
    if (target.length > SCRIPT_FS_MAX_PATH_LENGTH) throw nameTooLong(target);
    await this.guard(linkPath, false);
    await this.reserve(createBytes(linkPath) + 2 * target.length);
    await this.inner.symlink(target, linkPath);
    this.links.add(linkPath);
  }

  async link(existingPath: string, newPath: string): Promise<void> {
    await this.guard(existingPath, false);
    await this.guard(newPath);
    await this.reserve(createBytes(newPath));
    return this.inner.link(existingPath, newPath);
  }

  async readlink(path: string): Promise<string> {
    await this.guard(path, false);
    return this.inner.readlink(path);
  }

  async realpath(path: string): Promise<string> {
    await this.guard(path);
    return this.inner.realpath(path);
  }

  async utimes(path: string, atime: Date, mtime: Date): Promise<void> {
    await this.guard(path);
    return this.inner.utimes(path, atime, mtime);
  }
}
