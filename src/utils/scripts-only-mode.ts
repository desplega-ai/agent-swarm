export function resolveScriptsOnlyMode(opts: { env?: string; configValue?: string }): boolean {
  if (opts.env) return opts.env === "true";
  if (opts.configValue) return opts.configValue === "true";
  return false;
}
