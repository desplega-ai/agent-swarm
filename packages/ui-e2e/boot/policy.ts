export const PROD_API_HOSTS = ["api.desplega.agent-swarm.dev", "cloud.agent-swarm.dev"];

export type Target =
  | { mode: "local" }
  | { mode: "remote"; apiUrl: string; apiKey: string; uiUrl?: string; seed: boolean };

export function assertAllowedTarget(url: string): void {
  const host = new URL(url).hostname.replace(/\.+$/, "");
  if (
    PROD_API_HOSTS.some((productionHost) => productionHost.toLowerCase() === host.toLowerCase())
  ) {
    throw new Error(`refusing to run E2E against a production host: ${host}`);
  }
}

export function readTarget(env: Record<string, string | undefined>): Target {
  const apiUrl = env.E2E_API_URL?.replace(/\/+$/, "");
  if (!apiUrl) return { mode: "local" };

  const apiKey = env.E2E_API_KEY;
  if (!apiKey) throw new Error("E2E_API_KEY is required when E2E_API_URL is set");

  const uiUrl = env.E2E_UI_URL;
  return {
    mode: "remote",
    apiUrl,
    apiKey,
    ...(uiUrl ? { uiUrl } : {}),
    seed: env.E2E_REMOTE_SEED === "1" || env.E2E_REMOTE_SEED === "true",
  };
}
