const DEFAULT_MAX_STEPS_PER_RUN = 500;

// Read dynamically, NOT captured at module load: `src/http/index.ts` imports
// workflow modules before `loadGlobalConfigsIntoEnv()` hydrates `swarm_config`
// into `process.env`. A function also lets config reloads take effect live.
export function getMaxWorkflowStepsPerRun(): number {
  return Number(process.env.WORKFLOW_MAX_STEPS_PER_RUN) || DEFAULT_MAX_STEPS_PER_RUN;
}
