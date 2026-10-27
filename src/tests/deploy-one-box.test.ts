import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

// deploy/cloud-init.yaml embeds deploy/one-box/bootstrap.sh, and the DigitalOcean
// image ships the file itself. These checks keep the copies identical and pin the
// installer flags that keep the API key private and port 3013 off the internet.

const ROOT = resolve(import.meta.dir, "../..");
const read = (path: string) => Bun.file(resolve(ROOT, path)).text();

interface CloudConfig {
  write_files: { path: string; permissions?: string; content: string }[];
  runcmd: string[][];
}

describe("one-box deploy", () => {
  test("cloud-init.yaml embeds bootstrap.sh byte for byte and runs it", async () => {
    const yaml = await read("deploy/cloud-init.yaml");
    expect(yaml.startsWith("#cloud-config\n")).toBe(true);
    const config = Bun.YAML.parse(yaml) as CloudConfig;
    const script = config.write_files.find(
      (f) => f.path === "/usr/local/sbin/agent-swarm-bootstrap",
    );
    expect(script?.permissions).toBe("0700");
    // On a mismatch, copy deploy/one-box/bootstrap.sh into the write_files entry (6-space indent).
    expect(script?.content).toBe(await read("deploy/one-box/bootstrap.sh"));
    expect(config.runcmd).toEqual([["/usr/local/sbin/agent-swarm-bootstrap"]]);

    const settings = config.write_files.find((f) => f.path === "/etc/agent-swarm/deploy.env");
    expect(settings?.permissions).toBe("0600");
    expect(settings?.content).toContain("\nSWARM_DOMAIN=\n");
  });

  test("bootstrap.sh runs install.sh behind Caddy with loopback ports and a private log", async () => {
    const script = await read("deploy/one-box/bootstrap.sh");
    expect(script).toMatch(
      /bash "\$script" --dir "\$INSTALL_DIR" --preset "\$SWARM_PRESET" --no-tunnel \\\n\s+--public-url "https:\/\/\$\{host\}" --bind 127\.0\.0\.1 >>"\$LOG" 2>&1/,
    );
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell variable syntax
    expect(script).toContain("reverse_proxy 127.0.0.1:${API_PORT}");
    expect(script).toContain("assert_loopback_only\n");
    // The /setup link (it holds the API key) only goes to a root-only file.
    expect(script).toMatch(/umask 077\n\s+printf '%s\\n' "\$link" >"\$LINK_FILE"/);
    expect(script).not.toMatch(/(echo|printf|say)[^\n]*\$link\b(?![^\n]*>"\$LINK_FILE")/);
  });

  test("the DigitalOcean image runs the same bootstrap.sh on first boot", async () => {
    const template = await read("deploy/digitalocean/agent-swarm.pkr.hcl");
    // biome-ignore lint/suspicious/noTemplateCurlyInString: Packer HCL syntax
    expect(template).toContain('source      = "${path.root}/../one-box/bootstrap.sh"');
    expect(template).toContain('destination = "/opt/agent-swarm/bootstrap.sh"');
    const onboot = await read(
      "deploy/digitalocean/files/var/lib/cloud/scripts/per-instance/001_onboot",
    );
    expect(onboot).toContain("\n/opt/agent-swarm/bootstrap.sh\n");
    expect(onboot).toContain("trap unlock_root_ssh EXIT");
  });
});
