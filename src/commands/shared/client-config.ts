import pkg from "../../../package.json";

const PKG_NAME = pkg.name;
const SERVER_NAME = (pkg as { config?: { name?: string } }).config?.name ?? "agent-swarm";

export { SERVER_NAME };

export const createDefaultSettingsLocal = () => ({
  permissions: {
    allow: [] as string[],
  },
  enableAllProjectMcpServers: false,
  enabledMcpjsonServers: [] as string[],
  hooks: {} as Record<string, unknown>,
});

export const createDefaultMcpJson = () => ({
  mcpServers: {} as Record<string, unknown>,
});

export const createHooksConfig = () => {
  const hookCommand = `bunx ${PKG_NAME}@latest hook`;
  const hookEntry = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command: hookCommand,
      },
    ],
  };

  return {
    SessionStart: [hookEntry],
    UserPromptSubmit: [hookEntry],
    PreToolUse: [hookEntry],
    PostToolUse: [hookEntry],
    PreCompact: [hookEntry],
    Stop: [hookEntry],
  };
};
