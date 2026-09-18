export const SLACK_MODES = ["socket", "http"] as const;
export type SlackMode = (typeof SLACK_MODES)[number];

export type SlackConfiguration = {
  disabled: boolean;
  mode: SlackMode | null;
  missingCredentials: string[];
};

/** Resolve Slack transport and credential presence without exposing credential values. */
export function getSlackConfiguration(env: NodeJS.ProcessEnv = process.env): SlackConfiguration {
  const rawMode = env.SLACK_MODE === undefined ? "socket" : env.SLACK_MODE.trim();
  const mode = SLACK_MODES.includes(rawMode as SlackMode) ? (rawMode as SlackMode) : null;
  const missingCredentials = ["SLACK_BOT_TOKEN"];

  if (mode === "socket") missingCredentials.push("SLACK_APP_TOKEN");
  if (mode === "http") missingCredentials.push("SLACK_SIGNING_SECRET");

  return {
    disabled: env.SLACK_DISABLE === "true" || env.SLACK_DISABLE === "1",
    mode,
    missingCredentials: missingCredentials.filter((key) => !env[key]?.trim()),
  };
}

export function isSlackConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  const config = getSlackConfiguration(env);
  return !config.disabled && config.mode !== null && config.missingCredentials.length === 0;
}
