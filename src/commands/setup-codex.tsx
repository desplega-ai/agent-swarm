#!/usr/bin/env bun
import { constants } from "node:fs";
import { access, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { Spinner } from "@inkjs/ui";
import { Box, Text, useApp } from "ink";
import { useCallback, useEffect, useRef, useState } from "react";

const CODEX_CONFIG_CONTENT = `[mcp_servers.agent-swarm]
url = "http://localhost:3013/mcp"
bearer_token_env_var = "API_KEY"
env_http_headers = { "X-Agent-ID" = "AGENT_ID" }
`;

type SetupCodexStep = "running" | "done" | "error";

interface SetupCodexProps {
  dryRun?: boolean;
}

interface SetupCodexState {
  step: SetupCodexStep;
  logs: string[];
  error: string | null;
}

const fileExists = async (targetPath: string): Promise<boolean> => {
  try {
    await access(targetPath, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const getNextBackupPath = async (targetPath: string): Promise<string> => {
  let index = 0;
  while (true) {
    const backupPath = index === 0 ? `${targetPath}.bak` : `${targetPath}.bak.${index}`;
    if (!(await fileExists(backupPath))) {
      return backupPath;
    }
    index++;
  }
};

const getGitRoot = async (cwd: string): Promise<string | null> => {
  try {
    const result = await Bun.$`git -C ${cwd} rev-parse --show-toplevel`.quiet();
    const gitRoot = result.text().trim();
    return gitRoot.length > 0 ? gitRoot : null;
  } catch {
    return null;
  }
};

const hasTrackedCodexContent = async (gitRoot: string): Promise<boolean> => {
  try {
    const result = await Bun.$`git -C ${gitRoot} ls-files -- .codex`.quiet();
    return result.text().trim().length > 0;
  } catch {
    return false;
  }
};

const toDisplayPath = (cwd: string, targetPath: string): string => {
  const relativePath = relative(cwd, targetPath);
  return relativePath.length > 0 ? relativePath : targetPath;
};

export function SetupCodex({ dryRun = false }: SetupCodexProps) {
  const { exit } = useApp();
  const [state, setState] = useState<SetupCodexState>({
    step: "running",
    logs: [],
    error: null,
  });
  const hasRun = useRef(false);

  const addLog = useCallback(
    (message: string, isDryRunAction = false) => {
      const prefix = dryRun && isDryRunAction ? "[DRY-RUN] Would: " : "";
      setState((current) => ({
        ...current,
        logs: [...current.logs, `${prefix}${message}`],
      }));
    },
    [dryRun],
  );

  const createBackup = useCallback(
    async (targetPath: string, cwd: string) => {
      if (!(await fileExists(targetPath))) {
        return;
      }
      const backupPath = await getNextBackupPath(targetPath);
      if (!dryRun) {
        await copyFile(targetPath, backupPath);
      }
      addLog(`Backup ${toDisplayPath(cwd, targetPath)} -> ${toDisplayPath(cwd, backupPath)}`, true);
    },
    [addLog, dryRun],
  );

  useEffect(() => {
    if (hasRun.current) {
      return;
    }
    hasRun.current = true;

    const runSetup = async () => {
      const cwd = process.cwd();
      const codexDirPath = join(cwd, ".codex");
      const codexConfigPath = join(codexDirPath, "config.toml");

      if (!(await fileExists(codexDirPath))) {
        if (!dryRun) {
          await mkdir(codexDirPath, { recursive: true });
        }
        addLog("Create .codex directory", true);
      } else {
        addLog(".codex directory exists");
      }

      if (await fileExists(codexConfigPath)) {
        await createBackup(codexConfigPath, cwd);
      }

      if (!dryRun) {
        await writeFile(codexConfigPath, CODEX_CONFIG_CONTENT, "utf8");
      }
      addLog("Write .codex/config.toml", true);

      const gitRoot = await getGitRoot(cwd);
      if (!gitRoot) {
        addLog("Not a git repository (skipping .gitignore update)");
        setState((current) => ({ ...current, step: "done" }));
        return;
      }

      const trackedCodexContent = await hasTrackedCodexContent(gitRoot);
      const gitignoreEntry = trackedCodexContent ? "/.codex/config.toml" : ".codex/config.toml";
      const gitignorePath = join(gitRoot, ".gitignore");

      let gitignoreContent = "";
      const gitignoreExists = await fileExists(gitignorePath);
      if (gitignoreExists) {
        gitignoreContent = await readFile(gitignorePath, "utf8");
      }

      const gitignoreLines = gitignoreContent.split(/\r?\n/).map((line) => line.trim());
      if (gitignoreLines.includes(gitignoreEntry)) {
        addLog(`.gitignore already contains ${gitignoreEntry}`);
      } else {
        if (gitignoreExists) {
          await createBackup(gitignorePath, cwd);
        }
        const separator =
          gitignoreContent.length > 0 && !gitignoreContent.endsWith("\n") ? "\n" : "";
        const updatedContent = `${gitignoreContent}${separator}${gitignoreEntry}\n`;
        if (!dryRun) {
          await writeFile(gitignorePath, updatedContent, "utf8");
        }
        addLog(`Add ${gitignoreEntry} to .gitignore`, true);
      }

      setState((current) => ({ ...current, step: "done" }));
    };

    runSetup().catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      setState((current) => ({ ...current, step: "error", error: message }));
    });
  }, [addLog, createBackup, dryRun]);

  useEffect(() => {
    if (state.step === "done" || state.step === "error") {
      const timer = setTimeout(() => exit(), 500);
      return () => clearTimeout(timer);
    }
  }, [state.step, exit]);

  if (state.step === "error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          {state.logs.map((log, index) => (
            <Text key={`setup-codex-log-${index}-${log.slice(0, 24)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Text color="red">Setup failed: {state.error}</Text>
      </Box>
    );
  }

  if (state.step === "done") {
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
          {state.logs.map((log, index) => (
            <Text key={`setup-codex-log-${index}-${log.slice(0, 24)}`} dimColor>
              {log}
            </Text>
          ))}
        </Box>
        <Text color="green">{dryRun ? "Dry-run complete!" : "Codex setup complete!"}</Text>
        {!dryRun && (
          <Box flexDirection="column" marginTop={1}>
            <Text bold>Next steps:</Text>
            <Text>
              1. Export <Text color="cyan">API_KEY</Text> and <Text color="cyan">AGENT_ID</Text>
            </Text>
            <Text>2. Start Codex in this repository</Text>
          </Box>
        )}
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box flexDirection="column" marginBottom={1}>
        {state.logs.map((log, index) => (
          <Text key={`setup-codex-log-${index}-${log.slice(0, 24)}`} dimColor>
            {log}
          </Text>
        ))}
      </Box>
      <Spinner label="Setting up Codex MCP configuration..." />
    </Box>
  );
}
