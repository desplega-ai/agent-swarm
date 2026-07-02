const DEFAULT_MAX_STEPS = 1000;
const DEFAULT_MAX_WALL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_MAX_AGENT_TASKS = 50;

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

export function scriptRunMaxSteps(): number {
  return positiveIntEnv("SCRIPT_RUN_MAX_STEPS", DEFAULT_MAX_STEPS);
}

export function scriptRunMaxWallMs(): number {
  return positiveIntEnv("SCRIPT_RUN_MAX_WALL_MS", DEFAULT_MAX_WALL_MS);
}

export function scriptRunMaxAgentTasks(): number {
  return positiveIntEnv("SCRIPT_RUN_MAX_AGENT_TASKS", DEFAULT_MAX_AGENT_TASKS);
}
