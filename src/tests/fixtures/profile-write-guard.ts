/** Fail closed before old production code can overwrite the worker running this test. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/** Write APIs and the argument positions that name the path being written. */
const GUARDED: Array<[owner: object, name: string, targets: number[]]> = [
  ...(
    [
      ["writeFile", [0]],
      ["appendFile", [0]],
      ["rename", [0, 1]],
      ["mkdir", [0]],
      ["open", [0]],
      ["copyFile", [1]],
      ["cp", [1]],
      ["rm", [0]],
      ["rmdir", [0]],
      ["unlink", [0]],
      ["truncate", [0]],
      ["symlink", [1]],
      ["link", [1]],
    ] as const
  ).flatMap(
    ([name, targets]): Array<[object, string, number[]]> => [
      [promises, name, [...targets]],
      [fs, `${name}Sync`, [...targets]],
      [fs, name, [...targets]],
    ],
  ),
  [fs, "createWriteStream", [0]],
];

/** `open` only writes when its flags say so; a plain read must still work in a guarded child. */
function opensForWrite(flags: unknown): boolean {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === "number") {
    const { O_ACCMODE = 3, O_RDONLY, O_CREAT, O_TRUNC, O_APPEND } = fs.constants;
    return (flags & O_ACCMODE) !== O_RDONLY || (flags & (O_CREAT | O_TRUNC | O_APPEND)) !== 0;
  }
  return typeof flags === "string" && flags !== "r" && flags !== "rs" && flags !== "sr";
}

export function installProfileWriteGuard(
  directory: string,
  protectedPaths: { workspace: string; baselines: string } = {
    workspace: "/workspace",
    baselines: "/tmp/identity-baselines.json",
  },
  /**
   * `exit` (CAS fixtures): end the process, because the runner and hook catch IO
   * errors. `throw` (every other child, #884): fail the write like an unwritable
   * `/workspace` on CI, so a worker that tolerates that keeps running.
   */
  mode: "exit" | "throw" = "exit",
) {
  const sandbox = resolve(directory);
  const check = (target: unknown) => {
    const value =
      target instanceof URL
        ? fileURLToPath(target)
        : Buffer.isBuffer(target)
          ? target.toString()
          : typeof target === "object" && target !== null && "name" in target
            ? target.name
            : target;
    if (typeof value !== "string") return;
    const path = resolve(value);
    if (path === sandbox || path.startsWith(sandbox + sep)) return;
    if (
      path === resolve(protectedPaths.workspace) ||
      path.startsWith(resolve(protectedPaths.workspace) + sep) ||
      path === resolve(protectedPaths.baselines) ||
      path.startsWith(`${resolve(protectedPaths.baselines)}.`) ||
      path === "/workspace" ||
      path.startsWith("/workspace/") ||
      path === "/tmp/identity-baselines.json" ||
      path.startsWith("/tmp/identity-baselines.json.")
    ) {
      const message = `PROFILE WRITE GUARD: escritura fuera del sandbox: ${path}`;
      process.stderr.write(`${message}\n`);
      // The runner and hook catch IO errors; a throw alone can leave a successful child.
      if (mode === "exit") process.exit(86);
      throw Object.assign(new Error(message), { code: "EACCES", path });
    }
  };
  const restore: Array<() => void> = [];
  const write = Bun.write;
  restore.push(() => {
    Bun.write = write;
  });
  Bun.write = ((target, ...args) => {
    check(target);
    return write(target, ...args);
  }) as typeof Bun.write;
  const bunFile = Object.getPrototypeOf(Bun.file("/")) as Record<
    string,
    (this: { name?: string }, ...args: unknown[]) => unknown
  >;
  for (const name of ["write", "writer", "delete", "unlink"]) {
    const original = bunFile[name]!;
    restore.push(() => {
      bunFile[name] = original;
    });
    bunFile[name] = function (this: { name?: string }, ...args: unknown[]) {
      check(this?.name);
      return original.apply(this, args);
    };
  }
  for (const [owner, name, targets] of GUARDED) {
    const functions = owner as Record<string, (...args: unknown[]) => unknown>;
    const original = functions[name];
    if (typeof original !== "function") continue;
    restore.push(() => {
      functions[name] = original;
    });
    functions[name] = (...args: unknown[]) => {
      if (!name.startsWith("open") || opensForWrite(args[1])) {
        for (const index of targets) check(args[index]);
      }
      return original.apply(owner, args);
    };
  }
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}
