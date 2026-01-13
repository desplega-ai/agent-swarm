/**
 * Ralph Checkpoint State Management
 *
 * Filesystem-based checkpoint system for signaling between hooks and runner.
 * Checkpoints are written to /tmp/ralph-state/ and read by the runner to
 * detect when context fills up and a new iteration should be started.
 */

import { join } from "node:path";

const RALPH_STATE_DIR = process.env.RALPH_STATE_DIR || "/tmp/ralph-state";

export interface RalphCheckpoint {
  taskId: string;
  iteration: number;
  contextFull: boolean;
  timestamp: string;
  checkpointReason: "precompact" | "stop" | "manual";
}

/**
 * Write a checkpoint file for a Ralph task.
 * Called by hooks when context fills up or session ends.
 */
export async function writeCheckpoint(checkpoint: RalphCheckpoint): Promise<string> {
  const dir = RALPH_STATE_DIR;
  await Bun.$`mkdir -p ${dir}`.quiet();
  const filePath = join(dir, `${checkpoint.taskId}.checkpoint.json`);
  await Bun.write(filePath, JSON.stringify(checkpoint, null, 2));
  return filePath;
}

/**
 * Read a checkpoint file for a Ralph task.
 * Returns null if no checkpoint exists.
 */
export async function readCheckpoint(taskId: string): Promise<RalphCheckpoint | null> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    try {
      return (await file.json()) as RalphCheckpoint;
    } catch {
      // Invalid JSON or read error
      return null;
    }
  }
  return null;
}

/**
 * Clear a checkpoint file for a Ralph task.
 * Called by runner before starting a new iteration.
 */
export async function clearCheckpoint(taskId: string): Promise<void> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  try {
    await Bun.$`rm -f ${filePath}`.quiet();
  } catch {
    // File may not exist, ignore errors
  }
}

/**
 * Check if a checkpoint exists for a Ralph task.
 */
export async function hasCheckpoint(taskId: string): Promise<boolean> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  const file = Bun.file(filePath);
  return await file.exists();
}

/**
 * List all checkpoint files in the state directory.
 */
export async function listCheckpoints(): Promise<string[]> {
  const dir = RALPH_STATE_DIR;
  try {
    const files = await Bun.$`ls ${dir}/*.checkpoint.json 2>/dev/null`.quiet().text();
    return files
      .trim()
      .split("\n")
      .filter((f) => f.length > 0)
      .map((f) => f.replace(`${dir}/`, "").replace(".checkpoint.json", ""));
  } catch {
    return [];
  }
}
