declare module "@desplega.ai/localtunnel" {
  interface TunnelOptions {
    port: number;
    subdomain?: string;
    host?: string;
    auth?: string;
    username?: string;
    local_host?: string;
  }

  interface Tunnel {
    url: string;
    close(): void;
    on(event: "close", listener: () => void): void;
    on(event: "error", listener: (err: Error) => void): void;
  }

  function localtunnel(opts: TunnelOptions): Promise<Tunnel>;
  export default localtunnel;
}
