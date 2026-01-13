import { join } from "node:path";

const RALPH_STATE_DIR = process.env.RALPH_STATE_DIR || "/tmp/ralph-state";

export interface RalphCheckpoint {
  taskId: string;
  iteration: number;
  contextFull: boolean;
  timestamp: string;
  checkpointReason: "precompact" | "stop" | "manual";
}

export async function writeCheckpoint(checkpoint: RalphCheckpoint): Promise<string> {
  const dir = RALPH_STATE_DIR;
  await Bun.$`mkdir -p ${dir}`.quiet();
  const filePath = join(dir, `${checkpoint.taskId}.checkpoint.json`);
  await Bun.write(filePath, JSON.stringify(checkpoint, null, 2));
  return filePath;
}

export async function readCheckpoint(taskId: string): Promise<RalphCheckpoint | null> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    return await file.json();
  }
  return null;
}

export async function clearCheckpoint(taskId: string): Promise<void> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  try {
    await Bun.$`rm -f ${filePath}`.quiet();
  } catch {
    // Ignore errors if file doesn't exist
  }
}

/**
 * Get the Ralph state directory path
 */
export function getRalphStateDir(): string {
  return RALPH_STATE_DIR;
}
