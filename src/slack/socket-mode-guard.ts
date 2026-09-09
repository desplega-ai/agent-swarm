import { isEnvFlagEnabled } from "../utils/env-flag";

export const SLACK_DEV_SOCKET_MODE_OPT_IN = "SLACK_ALLOW_DEV_SOCKET_MODE";

export function getSlackSocketModeBlockReason(env: NodeJS.ProcessEnv): string | null {
  if (env.NODE_ENV !== "development") return null;
  if (isEnvFlagEnabled(SLACK_DEV_SOCKET_MODE_OPT_IN, false, env)) return null;

  return "NODE_ENV=development marks this as a dev/throwaway run";
}
