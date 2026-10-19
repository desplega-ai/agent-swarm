import { getSwarmConfigs } from "../be/db";

/** Stored values, including empty strings, override env values, as on config reload. */
export async function globalConfig(key: string): Promise<string | undefined> {
  const stored = (await getSwarmConfigs({ scope: "global", key }))?.[0]?.value;
  return (stored ?? process.env[key])?.trim() || undefined;
}
