import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  createDefaultMcpJson,
  createDefaultSettingsLocal,
  createHooksConfig,
  SERVER_NAME,
} from "../../shared/client-config.ts";
import type { StepProps } from "../types.ts";

type SubStep = "ask" | "connecting" | "done";

export function PostConnectStep({ state, dryRun, addLog, goToNext, goToStep }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("ask");
  const executed = useRef(false);

  useEffect(() => {
    if (subStep !== "connecting") return;
    if (executed.current) return;
    executed.current = true;

    const connect = async () => {
      const cwd = process.cwd();
      const mcpBaseUrl = `http://localhost:${state.apiPort || 3013}`;

      // Create .claude dir if needed
      if (!dryRun) {
        await Bun.$`mkdir -p ${cwd}/.claude`.quiet();
      }

      // Update .claude/settings.local.json
      const settingsPath = `${cwd}/.claude/settings.local.json`;
      const settingsFile = Bun.file(settingsPath);
      let settings: Record<string, unknown>;

      if (await settingsFile.exists()) {
        settings = await settingsFile.json();
      } else {
        settings = createDefaultSettingsLocal();
      }

      // Add permissions
      if (!settings.permissions) settings.permissions = { allow: [] };
      const perms = settings.permissions as { allow: string[] };
      if (!perms.allow) perms.allow = [];
      const permEntry = `mcp__${SERVER_NAME}__*`;
      if (!perms.allow.includes(permEntry)) {
        perms.allow.push(permEntry);
      }

      // Add enabled MCP server
      if (!settings.enabledMcpjsonServers) settings.enabledMcpjsonServers = [];
      const enabled = settings.enabledMcpjsonServers as string[];
      if (!enabled.includes(SERVER_NAME)) {
        enabled.push(SERVER_NAME);
      }

      // Add hooks
      settings.hooks = { ...((settings.hooks as object) || {}), ...createHooksConfig() };

      if (!dryRun) {
        await Bun.write(settingsPath, JSON.stringify(settings, null, 2));
      }
      addLog("Updated .claude/settings.local.json", true);

      // Update .mcp.json
      const mcpPath = `${cwd}/.mcp.json`;
      const mcpFile = Bun.file(mcpPath);
      let mcpConfig: Record<string, unknown>;

      if (await mcpFile.exists()) {
        mcpConfig = await mcpFile.json();
      } else {
        mcpConfig = createDefaultMcpJson();
      }

      if (!mcpConfig.mcpServers) mcpConfig.mcpServers = {};
      const servers = mcpConfig.mcpServers as Record<string, unknown>;
      servers[SERVER_NAME] = {
        type: "http",
        url: `${mcpBaseUrl}/mcp`,
        headers: {
          Authorization: `Bearer ${state.apiKey}`,
          "X-Agent-ID": crypto.randomUUID(),
        },
      };

      if (!dryRun) {
        await Bun.write(mcpPath, JSON.stringify(mcpConfig, null, 2));
      }
      addLog("Updated .mcp.json", true);

      setSubStep("done");
    };

    connect().catch((err) => addLog(`Connection error: ${err}`));
  }, [subStep, state.apiKey, state.apiPort, dryRun, addLog]);

  useEffect(() => {
    if (subStep === "done") {
      const timer = setTimeout(() => goToNext(), 500);
      return () => clearTimeout(timer);
    }
  }, [subStep, goToNext]);

  if (subStep === "ask") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Connect this project to the swarm?</Text>
        <Text dimColor>This will update .mcp.json and .claude/settings.local.json</Text>
        <Box marginTop={1}>
          <Select
            options={[
              { label: "Yes — connect now", value: "yes" },
              { label: "No — skip", value: "no" },
              { label: "Skip all post-deploy steps", value: "skip_all" },
            ]}
            onChange={(value) => {
              if (value === "yes") {
                setSubStep("connecting");
              } else if (value === "skip_all") {
                goToStep("done");
              } else {
                goToNext();
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (subStep === "connecting" || subStep === "done") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">
          {"✓"} Connected! Your local Claude Code is now linked to the swarm.
        </Text>
      </Box>
    );
  }

  return null;
}
