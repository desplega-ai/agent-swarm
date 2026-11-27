import { join, resolve } from "node:path";

// Test workers share the host filesystem. One override keeps their mirrors,
// pre-boot backups and baseline lock together for the lifetime of the worker.
const workspaceOverride = process.env.SWARM_WORKSPACE_DIR;
export const WORKSPACE_DIR = resolve(workspaceOverride || "/workspace");
export const SOUL_MD_PATH = join(WORKSPACE_DIR, "SOUL.md");
export const IDENTITY_MD_PATH = join(WORKSPACE_DIR, "IDENTITY.md");
export const TOOLS_MD_PATH = join(WORKSPACE_DIR, "TOOLS.md");
export const HEARTBEAT_MD_PATH = join(WORKSPACE_DIR, "HEARTBEAT.md");
// Non-Claude harnesses edit this mirror. Claude syncs its personal ~/.claude/CLAUDE.md.
export const WORKSPACE_CLAUDE_MD_PATH = join(WORKSPACE_DIR, "CLAUDE.md");
export const SETUP_SCRIPT_PREFIX = join(WORKSPACE_DIR, "start-up");
export const SETUP_SCRIPT_PATH = `${SETUP_SCRIPT_PREFIX}.sh`;
export const IDENTITY_BASELINES_PATH = join(
  workspaceOverride ? WORKSPACE_DIR : "/tmp",
  "identity-baselines.json",
);
