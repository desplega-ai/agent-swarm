/**
 * Native multi-agent tool names per harness, as the model sees them. One
 * source for the tool-mapping prompt templates, the live name check
 * (`bun run check:harness-native-tools`) and the evals counters.
 *
 * Verified on Claude Code 2.1.330 (SDK `BUILTIN_TOOL_NAMES`) and Codex CLI
 * 0.171.0 (`codex debug prompt-input`, `collaboration` namespace).
 */

export type NativeToolHarness = "claude" | "codex";

export type NativeToolSet = {
  /** Spawn a subagent. */
  spawn: string;
  /** List live agents. */
  list: string;
  /** Message a running agent. */
  message: string;
  /** Claude: stop a background agent. */
  stop?: string;
  /** Codex: give an existing agent a new task. */
  followup?: string;
  /** Codex: interrupt an agent's turn. */
  interrupt?: string;
  /** Codex: wait for an agent mailbox update. */
  wait?: string;
  /** Other names a session log or init list uses for the spawn tool. Not checked live. */
  spawnAliases?: string[];
};

export const NATIVE_TOOL_MAP: Record<NativeToolHarness, NativeToolSet> = {
  claude: {
    spawn: "Agent",
    list: "ListAgents",
    message: "SendMessage",
    stop: "TaskStop",
    // The Claude Code init tool list still reports the spawn tool as `Task`.
    spawnAliases: ["Task"],
  },
  codex: {
    spawn: "spawn_agent",
    list: "list_agents",
    message: "send_message",
    followup: "followup_task",
    interrupt: "interrupt_agent",
    wait: "wait_agent",
  },
};

/** The mapped names a live harness must expose (aliases excluded). */
export function mappedNativeToolNames(set: NativeToolSet): string[] {
  const { spawnAliases: _aliases, ...names } = set;
  return Object.values(names).filter((name): name is string => typeof name === "string");
}
