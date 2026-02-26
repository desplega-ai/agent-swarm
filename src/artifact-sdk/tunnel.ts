import localtunnel from "@desplega.ai/localtunnel";

interface TunnelOptions {
  port: number;
  subdomain: string;
  auth?: string;
  username?: string;
}

export async function createTunnel(opts: TunnelOptions) {
  const tunnel = await localtunnel({
    port: opts.port,
    subdomain: opts.subdomain,
    auth: opts.auth,
    username: opts.username || "hi", // default "hi" for MVP (custom username deferred)
    // host defaults to lt.desplega.ai in our fork
  });
  return tunnel;
}
