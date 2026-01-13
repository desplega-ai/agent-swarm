import { join } from "node:path";

const RALPH_STATE_DIR = process.env.RALPH_STATE_DIR || "/tmp/ralph-state";

export interface RalphCheckpoint {
  taskId: string;
  iteration: number;
  contextFull: boolean;
  timestamp: string;
  checkpointReason: "precompact" | "stop" | "manual";
}

export async function ensureStateDir(): Promise<void> {
  await Bun.$`mkdir -p ${RALPH_STATE_DIR}`.quiet();
}

export async function writeCheckpoint(checkpoint: RalphCheckpoint): Promise<string> {
  await ensureStateDir();
  const filePath = join(RALPH_STATE_DIR, `${checkpoint.taskId}.checkpoint.json`);
  await Bun.write(filePath, JSON.stringify(checkpoint, null, 2));
  return filePath;
}

export async function readCheckpoint(taskId: string): Promise<RalphCheckpoint | null> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  const file = Bun.file(filePath);
  if (await file.exists()) {
    try {
      return await file.json();
    } catch {
      return null;
    }
  }
  return null;
}

export async function clearCheckpoint(taskId: string): Promise<void> {
  const filePath = join(RALPH_STATE_DIR, `${taskId}.checkpoint.json`);
  try {
    await Bun.$`rm -f ${filePath}`.quiet();
  } catch {
    // File doesn't exist or can't be deleted - ignore
  }
}

export async function listCheckpoints(): Promise<RalphCheckpoint[]> {
  await ensureStateDir();
  const files = await Bun.$`ls ${RALPH_STATE_DIR}/*.checkpoint.json 2>/dev/null || true`.text();
  const checkpoints: RalphCheckpoint[] = [];

  for (const filePath of files.trim().split("\n").filter(Boolean)) {
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        checkpoints.push(await file.json());
      }
    } catch {
      // Skip invalid files
    }
  }

  return checkpoints;
}
