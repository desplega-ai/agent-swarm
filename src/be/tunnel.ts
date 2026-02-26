/**
 * Localtunnel integration for exposing agent services via public URLs.
 *
 * Opens a tunnel to lt.desplega.ai with the agent's UUID as subdomain,
 * providing a stable public URL: https://{agentId}.lt.desplega.ai
 */

// @ts-expect-error — @desplega.ai/localtunnel is a CJS package without type declarations
import localtunnel from "@desplega.ai/localtunnel";

const LT_HOST = "https://lt.desplega.ai";
const LT_PORT = 3000;

interface TunnelInstance {
  url: string;
  clientId: string;
  close: () => Promise<void>;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
}

interface TunnelOptions {
  agentId: string;
  apiKey: string;
  role: string;
}

let activeTunnel: TunnelInstance | null = null;
let reconnecting = false;

function log(role: string, msg: string): void {
  console.log(`[${role}] [tunnel] ${msg}`);
}

function warn(role: string, msg: string): void {
  console.warn(`[${role}] [tunnel] ${msg}`);
}

/**
 * Start a localtunnel tunnel for this agent.
 * Returns the public URL on success, or null if the tunnel could not be opened.
 */
export async function startTunnel(opts: TunnelOptions): Promise<string | null> {
  if (activeTunnel) {
    log(opts.role, `Tunnel already active at ${activeTunnel.url}`);
    return activeTunnel.url;
  }

  try {
    log(opts.role, `Opening tunnel to ${LT_HOST} (subdomain: ${opts.agentId})...`);

    const tunnel: TunnelInstance = await localtunnel({
      port: LT_PORT,
      host: LT_HOST,
      subdomain: opts.agentId,
      auth: opts.apiKey,
    });

    activeTunnel = tunnel;
    log(opts.role, `Tunnel open: ${tunnel.url}`);

    // Handle tunnel close/error for auto-reconnection
    tunnel.on("close", () => {
      log(opts.role, "Tunnel closed");
      activeTunnel = null;

      if (!reconnecting) {
        reconnecting = true;
        log(opts.role, "Scheduling reconnection in 3s...");
        setTimeout(async () => {
          reconnecting = false;
          try {
            await startTunnel(opts);
          } catch (err) {
            warn(opts.role, `Reconnection failed: ${(err as Error).message}`);
          }
        }, 3000);
      }
    });

    tunnel.on("error", (err: unknown) => {
      warn(opts.role, `Tunnel error: ${(err as Error).message}`);
    });

    return tunnel.url;
  } catch (err) {
    warn(opts.role, `Failed to open tunnel: ${(err as Error).message}`);
    return null;
  }
}

/**
 * Stop the active tunnel. Safe to call if no tunnel is active.
 */
export async function stopTunnel(role: string): Promise<void> {
  if (!activeTunnel) return;

  try {
    log(role, "Closing tunnel...");
    // Prevent reconnection during intentional shutdown
    reconnecting = true;
    await activeTunnel.close();
    activeTunnel = null;
    log(role, "Tunnel closed");
  } catch (err) {
    warn(role, `Error closing tunnel: ${(err as Error).message}`);
    activeTunnel = null;
  }
}

/**
 * Get the URL of the currently active tunnel.
 */
export function getTunnelUrl(): string | null {
  return activeTunnel?.url ?? null;
}
