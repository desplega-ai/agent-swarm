import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerVolatileSecret } from "../utils/secret-scrubber";
import { ACPAdapter } from "./acp-adapter";
import { grokTargetProfile } from "./acp-targets";
import type {
  CredStatus,
  ProviderAdapter,
  ProviderSession,
  ProviderSessionConfig,
  ProviderTraits,
} from "./types";

/**
 * The xAI Grok CLI (`@xai-official/grok`) on the swarm's ACP client:
 * `grok agent --no-leader stdio` is an ACP server, so spawn, swarm MCP
 * injection, permissions, event translation and cost all come from
 * {@link ACPAdapter}. This adapter adds the per-session `GROK_HOME`.
 *
 * Auth is `XAI_API_KEY` only. A SuperGrok OAuth pool needs the CLI's
 * `auth.json` refresh behaviour measured first (issue #1952 follow-up).
 */
export function checkGrokCredentials(env: Record<string, string | undefined>): CredStatus {
  return env.XAI_API_KEY?.trim()
    ? { ready: true, missing: [], satisfiedBy: "env" }
    : {
        ready: false,
        missing: ["XAI_API_KEY"],
        hint: "Set XAI_API_KEY (an xAI API key from console.x.ai) for grok.",
      };
}

/**
 * Claude Code plugins installed for the worker's own harness. Grok discovers
 * `~/.claude/plugins` and loads their MCP servers even with Claude MCP compat
 * off, so each one is listed in `[plugins].disabled`.
 */
export async function installedClaudePluginNames(home: string | undefined): Promise<string[]> {
  if (!home) return [];
  try {
    const raw = await readFile(join(home, ".claude", "plugins", "installed_plugins.json"), "utf8");
    const parsed = JSON.parse(raw) as { plugins?: Record<string, unknown> };
    const ids = Object.keys(parsed.plugins ?? {});
    // Keys are `<plugin>@<marketplace>`; Grok matches on the plugin name.
    return [...new Set(ids.map((id) => id.split("@")[0] ?? "").filter(Boolean))];
  } catch {
    return [];
  }
}

/** `$GROK_HOME/config.toml` for one swarm session. */
export function buildGrokConfigToml(disabledPlugins: readonly string[]): string {
  const list = disabledPlugins.map((name) => JSON.stringify(name)).join(", ");
  return [
    "[cli]",
    "auto_update = false",
    "",
    "[compat.codex]",
    "hooks = false",
    "skills = false",
    "",
    "[plugins]",
    `disabled = [${list}]`,
    "",
  ].join("\n");
}

/**
 * `$GROK_HOME/requirements.toml`: a policy pin that skips every hook outside
 * managed policy at dispatch (plugin hooks and the Claude/Cursor compat
 * files included), so the worker's own Claude hooks never fire inside Grok.
 * `grok inspect` reports it as "Hooks outside managed policy disabled".
 */
export const GROK_REQUIREMENTS_TOML = "allow_managed_hooks_only = true\n";

export class GrokAdapter implements ProviderAdapter {
  readonly name = "grok";

  readonly traits: ProviderTraits = {
    hasMcp: true,
    hasToolSearch: false,
    // Claude skills compat stays on, so Grok lists ~/.claude/skills itself.
    nativeSkillDiscovery: true,
    hasLocalEnvironment: true,
    steerModes: [],
  };

  private readonly acp = new ACPAdapter({ providerName: "grok", target: grokTargetProfile });

  async createSession(config: ProviderSessionConfig): Promise<ProviderSession> {
    const env = { ...process.env, ...config.env };
    const apiKey = env.XAI_API_KEY?.trim();
    if (!apiKey) throw new Error("grok requires XAI_API_KEY");
    registerVolatileSecret(apiKey, "XAI_API_KEY");

    // A fresh GROK_HOME per session: no shared auth.json, sessions or leader
    // socket between tasks, and the config below applies to this run only.
    const grokHome = await mkdtemp(join(tmpdir(), "swarm-grok-"));
    try {
      await writeFile(
        join(grokHome, "config.toml"),
        buildGrokConfigToml(await installedClaudePluginNames(env.HOME)),
        { mode: 0o600 },
      );
      await writeFile(join(grokHome, "requirements.toml"), GROK_REQUIREMENTS_TOML, {
        mode: 0o600,
      });
      const session = await this.acp.createSession({
        ...config,
        env: { ...config.env, XAI_API_KEY: apiKey, GROK_HOME: grokHome },
      });
      void session
        .waitForCompletion()
        .finally(() => rm(grokHome, { recursive: true, force: true }));
      return session;
    } catch (error) {
      await rm(grokHome, { recursive: true, force: true });
      throw error;
    }
  }

  async canResume(_sessionId: string): Promise<boolean> {
    return false;
  }

  formatCommand(commandName: string): string {
    return `/${commandName}`;
  }
}
