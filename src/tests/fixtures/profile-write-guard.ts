/** Fail closed before old production code can overwrite the worker running this test. */
import fs from "node:fs";
import promises from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

export function installProfileWriteGuard(
  directory: string,
  protectedPaths: { workspace: string; baselines: string } = {
    workspace: "/workspace",
    baselines: "/tmp/identity-baselines.json",
  },
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
      process.stderr.write(`PROFILE WRITE GUARD: escritura fuera del sandbox: ${path}\n`);
      // The runner and hook catch IO errors; a throw alone can leave a successful child.
      process.exit(86);
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
  for (const [owner, names] of [
    [promises, ["writeFile", "rename", "mkdir", "open"]],
    [fs, ["writeFileSync", "renameSync", "mkdirSync", "openSync"]],
  ] as const) {
    for (const name of names) {
      const functions = owner as unknown as Record<string, (...args: unknown[]) => unknown>;
      const original = functions[name]!;
      restore.push(() => {
        functions[name] = original;
      });
      functions[name] = (...args: unknown[]) => {
        check(args[0]);
        if (name === "rename" || name === "renameSync") check(args[1]);
        return original.apply(owner, args);
      };
    }
  }
  return () => {
    for (const undo of restore.reverse()) undo();
  };
}
