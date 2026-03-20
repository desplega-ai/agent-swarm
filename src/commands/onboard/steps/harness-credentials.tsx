import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep = "choose" | "running_cli" | "cli_error" | "manual_input";

export function HarnessCredentialsStep({ goToNext, goToError: _goToError, addLog }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("choose");
  const [cliErrorMsg, setCliErrorMsg] = useState("");

  const handleToken = (token: string) => {
    const trimmed = token.trim();
    if (!trimmed) {
      addLog("Token cannot be empty.");
      return;
    }
    addLog("Claude OAuth token collected");
    goToNext({ claudeOAuthToken: trimmed });
  };

  if (subStep === "choose") {
    // Use a simple two-option approach with TextInput acting as a selector
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>How would you like to provide your Claude OAuth token?</Text>
        <Box marginTop={1} flexDirection="column">
          <Text>
            {"  "}1. Run <Text color="cyan">claude setup-token</Text> (recommended)
          </Text>
          <Text>{"  "}2. Paste token manually</Text>
        </Box>
        <Box marginTop={1}>
          <Text>Enter choice (1 or 2): </Text>
          <TextInput
            placeholder="1"
            onSubmit={(value) => {
              const choice = value.trim() || "1";
              if (choice === "1") {
                setSubStep("running_cli");
                runSetupToken(addLog, setSubStep, setCliErrorMsg);
              } else if (choice === "2") {
                setSubStep("manual_input");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (subStep === "running_cli") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text>
          Running <Text color="cyan">claude setup-token</Text>...
        </Text>
        <Text dimColor>Follow the prompts in your terminal.</Text>
      </Box>
    );
  }

  if (subStep === "cli_error") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="red">Could not run claude setup-token: {cliErrorMsg}</Text>
        <Text dimColor>Falling back to manual token entry.</Text>
        <Box marginTop={1} flexDirection="column">
          <Text bold>Paste your CLAUDE_CODE_OAUTH_TOKEN:</Text>
          <TextInput placeholder="your-oauth-token" onSubmit={handleToken} />
        </Box>
      </Box>
    );
  }

  if (subStep === "manual_input") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Paste your CLAUDE_CODE_OAUTH_TOKEN:</Text>
        <TextInput placeholder="your-oauth-token" onSubmit={handleToken} />
      </Box>
    );
  }

  return null;
}

async function runSetupToken(
  addLog: (msg: string) => void,
  setSubStep: (step: SubStep) => void,
  setCliErrorMsg: (msg: string) => void,
) {
  try {
    const result = await Bun.$`claude setup-token`.quiet();
    const output = result.text().trim();

    if (result.exitCode !== 0) {
      addLog("claude setup-token exited with a non-zero code");
      setCliErrorMsg("Command exited with a non-zero code. Is Claude CLI installed?");
      setSubStep("cli_error");
      return;
    }

    // Try to extract token from output, or just trust that it wrote to the right place
    // The token is typically stored by the CLI itself; prompt user to paste it
    if (output) {
      addLog("claude setup-token completed");
    }

    // After setup-token, the token is stored locally by Claude CLI.
    // We still need the user to provide it for our config.
    addLog("Token configured via Claude CLI. Please paste it for Agent Swarm config.");
    setSubStep("manual_input");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    addLog(`Failed to run claude setup-token: ${msg}`);
    setCliErrorMsg(msg);
    setSubStep("cli_error");
  }
}
