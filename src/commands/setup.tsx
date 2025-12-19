#!/usr/bin/env bun
import { Spinner, TextInput } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";
import pkg from "../../package.json";

const SERVER_NAME = (pkg as { config?: { name?: string } }).config?.name ?? "agent-swarm";
const PKG_NAME = pkg.name;
const DEFAULT_MCP_BASE_URL = "https://agent-swarm-mcp.desplega.sh";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isValidUUID = (value: string): boolean => UUID_REGEX.test(value);

type SetupStep =
  | "check_dirs"
  | "restoring"
  | "input_token"
  | "input_agent_id"
  | "updating"
  | "done"
  | "error";

interface SetupProps {
  dryRun?: boolean;
  restore?: boolean;
  yes?: boolean;
}

const BACKUP_FILES = [".claude/settings.local.json", ".mcp.json", ".gitignore"];

interface SetupState {
  step: SetupStep;
  token: string;
  agentId: string;
  existingToken: string;
  existingAgentId: string;
  error: string | null;
  logs: string[];
  isGitRepo: boolean;
}

const createDefaultSettingsLocal = () => ({
  permissions: {
    allow: [],
  },
  enableAllProjectMcpServers: false,
  enabledMcpjsonServers: [],
  hooks: {},
});

const createDefaultMcpJson = () => ({
  mcpServers: {},
});

const createHooksConfig = () => {
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

export function Setup({ dryRun = false, restore = false, yes = false }: SetupProps) {
  const { exit } = useApp();
  const [state, setState] = useState<SetupState>({
    step: restore ? "restoring" : "check_dirs",
    token: yes ? process.env.API_KEY || "" : "",
    agentId: yes ? process.env.AGENT_ID || "" : "",
    existingToken: "",
    existingAgentId: "",
    error: null,
    logs: [],
    isGitRepo: false,
  });

  // Track which steps have been executed to prevent duplicates
  const executedSteps = useRef<Set<SetupStep>>(new Set());

  const addLog = useCallback(
    (log: string, isDryRunAction = false) => {
      const prefix = isDryRunAction && dryRun ? "[DRY-RUN] Would: " : "";
      setState((s) => ({ ...s, logs: [...s.logs, `${prefix}${log}`] }));
    },
    [dryRun],
  );

  // Helper to create backup
  const createBackup = useCallback(
    async (filePath: string): Promise<boolean> => {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const backupPath = `${filePath}.bak`;
        if (!dryRun) {
          const content = await file.text();
          await Bun.write(backupPath, content);
        }
        addLog(`Backup: ${filePath} -> ${filePath}.bak`, true);
        return true;
      }
      return false;
    },
    [dryRun, addLog],
  );

  // Handle restore mode
  useEffect(() => {
    if (state.step !== "restoring") return;
    if (executedSteps.current.has("restoring")) return;
    executedSteps.current.add("restoring");

    const restoreFiles = async () => {
      const cwd = process.cwd();
      let restoredCount = 0;

      for (const relativePath of BACKUP_FILES) {
        const backupPath = `${cwd}/${relativePath}.bak`;
        const originalPath = `${cwd}/${relativePath}`;
        const backupFile = Bun.file(backupPath);

        if (await backupFile.exists()) {
          if (!dryRun) {
            const content = await backupFile.text();
            await Bun.write(originalPath, content);
            await Bun.$`rm ${backupPath}`;
          }
          addLog(`Restore: ${relativePath}.bak -> ${relativePath}`, true);
          restoredCount++;
        } else {
          addLog(`No backup found: ${relativePath}.bak`);
        }
      }

      if (restoredCount === 0) {
        setState((s) => ({
          ...s,
          step: "error",
          error: "No backup files found to restore",
        }));
      } else {
        setState((s) => ({ ...s, step: "done" }));
      }
    };

    restoreFiles().catch((err) => {
      setState((s) => ({ ...s, step: "error", error: err.message }));
    });
  }, [state.step, dryRun, addLog]);

  // Step 1: Check and create directories/files
  useEffect(() => {
    if (state.step !== "check_dirs") return;
    if (executedSteps.current.has("check_dirs")) return;
    executedSteps.current.add("check_dirs");

    const checkDirs = async () => {
      const cwd = process.cwd();

      // Check if .claude dir exists
      const claudeDir = Bun.file(`${cwd}/.claude`);
      if (!(await claudeDir.exists())) {
        if (!dryRun) {
          await Bun.$`mkdir -p ${cwd}/.claude`;
        }
        addLog("Create .claude directory", true);
      } else {
        addLog(".claude directory exists");
      }

      // Check if .claude/settings.local.json exists
      const settingsFile = Bun.file(`${cwd}/.claude/settings.local.json`);
      if (!(await settingsFile.exists())) {
        if (!dryRun) {
          await Bun.write(settingsFile, JSON.stringify(createDefaultSettingsLocal(), null, 2));
        }
        addLog("Create .claude/settings.local.json", true);
      } else {
        addLog(".claude/settings.local.json exists");
      }

      // Check if .mcp.json exists
      const mcpFile = Bun.file(`${cwd}/.mcp.json`);
      if (!(await mcpFile.exists())) {
        if (!dryRun) {
          await Bun.write(mcpFile, JSON.stringify(createDefaultMcpJson(), null, 2));
        }
        addLog("Create .mcp.json", true);
      } else {
        addLog(".mcp.json exists");
      }

      // Check if it's a git repo by finding the git root
      let isGitRepo = false;
      let gitRoot = "";
      try {
        const result = await Bun.$`git -C ${cwd} rev-parse --show-toplevel`.quiet();
        gitRoot = result.text().trim();
        isGitRepo = result.exitCode === 0 && gitRoot.length > 0;
      } catch {
        isGitRepo = false;
      }

      if (isGitRepo) {
        addLog(`Git repository detected (root: ${gitRoot})`);

        // Check .gitignore at git root
        const gitignoreFile = Bun.file(`${gitRoot}/.gitignore`);
        let gitignoreContent = "";

        if (await gitignoreFile.exists()) {
          gitignoreContent = await gitignoreFile.text();
        }

        const entriesToAdd: string[] = [];
        if (!gitignoreContent.includes(".claude")) {
          entriesToAdd.push(".claude");
        }
        if (!gitignoreContent.includes(".mcp.json")) {
          entriesToAdd.push(".mcp.json");
        }

        if (entriesToAdd.length > 0) {
          // Backup .gitignore before modifying
          await createBackup(`${gitRoot}/.gitignore`);
          if (!dryRun) {
            const newEntries = `# Added by ${SERVER_NAME} setup\n${entriesToAdd.join("\n")}\n\n`;
            await Bun.write(gitignoreFile, newEntries + gitignoreContent);
          }
          addLog(`Add to .gitignore: ${entriesToAdd.join(", ")}`, true);
        } else {
          addLog(".gitignore already contains required entries");
        }
      } else {
        addLog("Not a git repository (skipping .gitignore update)");
      }

      // Try to read existing values from .mcp.json
      let existingToken = "";
      let existingAgentId = "";
      try {
        const mcpFile = Bun.file(`${cwd}/.mcp.json`);
        if (await mcpFile.exists()) {
          const mcpConfig = await mcpFile.json();
          const serverConfig = mcpConfig?.mcpServers?.[SERVER_NAME];
          if (serverConfig?.headers) {
            const authHeader = serverConfig.headers.Authorization || "";
            if (authHeader.startsWith("Bearer ")) {
              existingToken = authHeader.slice(7);
            }
            existingAgentId = serverConfig.headers["X-Agent-ID"] || "";
          }
          if (existingToken || existingAgentId) {
            addLog("Found existing configuration values");
          }
        }
      } catch {
        // Ignore errors reading existing config
      }

      // In non-interactive mode (yes=true), skip prompts and go directly to updating
      if (yes) {
        const token = process.env.API_KEY;
        const agentId = process.env.AGENT_ID;

        if (!token) {
          setState((s) => ({
            ...s,
            step: "error",
            error: "API_KEY environment variable is required in non-interactive mode (-y/--yes)",
          }));
          return;
        }

        addLog("Non-interactive mode: using environment variables");
        setState((s) => ({
          ...s,
          step: "updating",
          isGitRepo,
          token,
          agentId: agentId || "",
        }));
        return;
      }

      setState((s) => ({
        ...s,
        step: "input_token",
        isGitRepo,
        existingToken,
        existingAgentId,
      }));
    };

    checkDirs().catch((err) => {
      setState((s) => ({ ...s, step: "error", error: err.message }));
    });
  }, [state.step, dryRun, yes, addLog, createBackup]);

  // Handle final update step
  useEffect(() => {
    if (state.step !== "updating") return;
    if (executedSteps.current.has("updating")) return;
    executedSteps.current.add("updating");

    const updateFiles = async () => {
      const cwd = process.cwd();
      const mcpBaseUrl = process.env.MCP_BASE_URL || DEFAULT_MCP_BASE_URL;

      // For dry-run, show what would be written
      const generatedAgentId = state.agentId || crypto.randomUUID();

      // Create backups before modifying
      await createBackup(`${cwd}/.claude/settings.local.json`);
      await createBackup(`${cwd}/.mcp.json`);

      // Update .claude/settings.local.json
      const settingsFile = Bun.file(`${cwd}/.claude/settings.local.json`);
      let settings: Record<string, unknown>;

      if (dryRun && !(await settingsFile.exists())) {
        settings = createDefaultSettingsLocal();
      } else {
        settings = await settingsFile.json();
      }

      // Ensure permissions.allow exists and add mcp__agent-swarm__*
      if (!settings.permissions) {
        settings.permissions = { allow: [] };
      }
      const permissions = settings.permissions as { allow: string[] };
      if (!permissions.allow) {
        permissions.allow = [];
      }
      const permissionEntry = `mcp__${SERVER_NAME}__*`;
      if (!permissions.allow.includes(permissionEntry)) {
        permissions.allow.push(permissionEntry);
        addLog(`Add "${permissionEntry}" to permissions.allow`, true);
      }

      // Ensure enabledMcpjsonServers exists and add agent-swarm
      if (!settings.enabledMcpjsonServers) {
        settings.enabledMcpjsonServers = [];
      }
      const enabledServers = settings.enabledMcpjsonServers as string[];
      if (!enabledServers.includes(SERVER_NAME)) {
        enabledServers.push(SERVER_NAME);
        addLog(`Add "${SERVER_NAME}" to enabledMcpjsonServers`, true);
      }

      // Add hooks
      const newHooks = createHooksConfig();
      settings.hooks = { ...((settings.hooks as object) || {}), ...newHooks };
      addLog("Add hooks configuration", true);

      if (!dryRun) {
        await Bun.write(settingsFile, JSON.stringify(settings, null, 2));
      }
      addLog("Update .claude/settings.local.json", true);

      // Update .mcp.json
      const mcpFile = Bun.file(`${cwd}/.mcp.json`);
      let mcpConfig: Record<string, unknown>;

      if (dryRun && !(await mcpFile.exists())) {
        mcpConfig = createDefaultMcpJson();
      } else {
        mcpConfig = await mcpFile.json();
      }

      if (!mcpConfig.mcpServers) {
        mcpConfig.mcpServers = {};
      }

      const mcpServers = mcpConfig.mcpServers as Record<string, unknown>;
      mcpServers[SERVER_NAME] = {
        type: "http",
        url: `${mcpBaseUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${state.token}`,
          "X-Agent-ID": generatedAgentId,
        },
      };

      if (!dryRun) {
        await Bun.write(mcpFile, JSON.stringify(mcpConfig, null, 2));
      }
      addLog("Update .mcp.json with server configuration", true);

      if (dryRun) {
        addLog("");
        addLog(`Agent ID that would be used: ${generatedAgentId}`);
      }

      setState((s) => ({ ...s, step: "done" }));
    };

    updateFiles().catch((err) => {
      setState((s) => ({ ...s, step: "error", error: err.message }));
    });
  }, [state.step, state.token, state.agentId, dryRun, addLog, createBackup]);

  // Exit on done
  useEffect(() => {
    if (state.step === "done" || state.step === "error") {
      const timer = setTimeout(() => exit(), 500);
      return () => clearTimeout(timer);
    }
  }, [state.step, exit]);

  if (state.step === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Setup failed: {state.error}</Text>
      </Box>
    );
  }

  if (state.step === "restoring") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {state.logs.map((log, i) => (
            <Text key={`log-${i}-${log.slice(0, 20)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Spinner label="Restoring from backups..." />
      </Box>
    );
  }

  if (state.step === "check_dirs") {
    return (
      <Box padding={1}>
        <Spinner label="Checking directories and files..." />
      </Box>
    );
  }

  if (state.step === "input_token") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {state.logs.map((log, i) => (
            <Text key={`log-${i}-${log.slice(0, 20)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Box>
            <Text bold>Enter your API token</Text>
            {state.existingToken && (
              <Text dimColor> (current: {state.existingToken.slice(0, 8)}...)</Text>
            )}
            <Text bold>: </Text>
          </Box>
          <TextInput
            key="token-input"
            defaultValue={state.existingToken}
            placeholder="your-api-token"
            onSubmit={(value) => {
              if (!value.trim()) {
                setState((s) => ({
                  ...s,
                  step: "error",
                  error: "API token is required",
                }));
                return;
              }
              setState((s) => ({ ...s, token: value, step: "input_agent_id" }));
            }}
          />
        </Box>
      </Box>
    );
  }

  if (state.step === "input_agent_id") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {state.logs.map((log, i) => (
            <Text key={`log-${i}-${log.slice(0, 20)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Box flexDirection="column">
          <Box>
            <Text bold>Enter your Agent ID</Text>
            {state.existingAgentId && <Text dimColor> (current: {state.existingAgentId})</Text>}
          </Box>
          <Text dimColor>(optional, press Enter to generate a new one): </Text>
          <TextInput
            key="agent-id-input"
            defaultValue={state.existingAgentId}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (trimmed && !isValidUUID(trimmed)) {
                setState((s) => ({
                  ...s,
                  step: "error",
                  error: "Invalid UUID format. Expected: xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
                }));
                return;
              }
              setState((s) => ({ ...s, agentId: trimmed, step: "updating" }));
            }}
          />
        </Box>
      </Box>
    );
  }

  if (state.step === "updating") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {state.logs.map((log, i) => (
            <Text key={`log-${i}-${log.slice(0, 20)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Spinner label="Updating configuration files..." />
      </Box>
    );
  }

  if (state.step === "done") {
    const mcpBaseUrl = process.env.MCP_BASE_URL || DEFAULT_MCP_BASE_URL;

    const getDoneMessage = () => {
      if (dryRun && restore) return "Dry-run restore complete!";
      if (dryRun) return "Dry-run complete!";
      if (restore) return "Restore complete!";
      return "Setup complete!";
    };

    return (
      <Box flexDirection="column" padding={1}>
        {dryRun && (
          <Box marginBottom={1}>
            <Text color="yellow" bold>
              DRY-RUN MODE - No changes were made
            </Text>
          </Box>
        )}
        <Box flexDirection="column" marginBottom={1}>
          {state.logs.map((log, i) => (
            <Text key={`log-${i}-${log.slice(0, 20)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Box marginTop={1}>
          <Text color="green">{getDoneMessage()}</Text>
        </Box>
        {!dryRun && !restore && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Next steps:</Text>
            <Text>
              1. Set the <Text color="cyan">MCP_BASE_URL</Text> environment variable in your .env
              file
            </Text>
            <Text dimColor> (Default: {DEFAULT_MCP_BASE_URL})</Text>
            <Text dimColor> (Current: {mcpBaseUrl})</Text>
            <Text>2. Restart Claude Code to apply the changes</Text>
          </Box>
        )}
        {!dryRun && restore && (
          <Box flexDirection="column" marginTop={1}>
            <Text>Files restored from backups. Restart Claude Code to apply.</Text>
          </Box>
        )}
        {dryRun && !restore && (
          <Box flexDirection="column" marginTop={1}>
            <Text>Run without --dry-run to apply these changes.</Text>
          </Box>
        )}
        {dryRun && restore && (
          <Box flexDirection="column" marginTop={1}>
            <Text>Run without --dry-run to restore from backups.</Text>
          </Box>
        )}
      </Box>
    );
  }

  return null;
}
