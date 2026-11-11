/** Sandbox the real hook's files in a child process; no worker workspace writes. */
import { mock } from "bun:test";
import { basename, join } from "node:path";

const directory = process.argv[2]!;
const local = (path: string) =>
  path.startsWith("/workspace/") || path === "/tmp/identity-baselines.json"
    ? join(directory, basename(path))
    : path;
const file = Bun.file;
Bun.file = ((path: string, ...args: unknown[]) =>
  file(typeof path === "string" ? local(path) : path, ...args)) as typeof Bun.file;
const profile = await import("../../commands/profile-sync");
mock.module("../../commands/profile-sync", () => ({
  ...profile,
  PROFILE_FILE_IO: {
    readFile: profile.readFileIfExists,
    writeFile: async (path: string, content: string) => {
      await Bun.write(local(path), content);
    },
    baselinesLockPath: join(directory, "baselines.lock"),
  },
}));
const { handleHook } = await import("../../hooks/hook");
await handleHook();
process.exit(0);
