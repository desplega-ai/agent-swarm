import os from "node:os";

/**
 * Home directory that owns `~/.codex`.
 *
 * Prefers `process.env.HOME` over `os.homedir()`. Bun resolves `os.homedir()`
 * once at process start, so a HOME override set later in the same process
 * (test isolation, harness sandboxes) is ignored by `os.homedir()` and writes
 * would land in the real home directory. `process.env.HOME` is read live.
 */
export function codexUserHome(): string {
  return process.env.HOME || os.homedir();
}
