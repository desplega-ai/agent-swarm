export function isLeadChannelMonitoringEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LEAD_MONITOR_CHANNELS === "true";
}
