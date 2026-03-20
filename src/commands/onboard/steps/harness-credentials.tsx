import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep =
  | "choose_method"
  | "running_cli"
  | "confirm_token"
  | "manual_oauth"
  | "manual_api_key";

const TOKEN_REGEX = /sk-ant-oat[^\s]+/;

export function HarnessCredentialsStep({ goToNext, addLog }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("choose_method");
  const [cliOutput, setCliOutput] = useState("");
  const [parsedToken, setParsedToken] = useState("");
  const [cliError, setCliError] = useState("");

  // Run CLI when entering running_cli
  useEffect(() => {
    if (subStep !== "running_cli") return;

    let cancelled = false;

    (async () => {
      try {
        const result = await Bun.$`claude setup-token`.quiet();
        if (cancelled) return;

        const output = result.text().trim();
        setCliOutput(output);

        if (result.exitCode !== 0) {
          addLog("claude setup-token exited with a non-zero code");
          setCliError("Command exited with a non-zero code. Is Claude CLI installed?");
          setSubStep("manual_oauth");
          return;
        }

        const match = output.match(TOKEN_REGEX);
        if (match) {
          addLog("Token detected from claude setup-token output");
          setParsedToken(match[0]);
          setSubStep("confirm_token");
        } else {
          addLog("claude setup-token completed but no token found in output");
          setSubStep("manual_oauth");
        }
      } catch (err) {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        addLog(`Failed to run claude setup-token: ${msg}`);
        setCliError(msg);
        setSubStep("manual_oauth");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [subStep, addLog]);

  if (subStep === "choose_method") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>How would you like to provide credentials?</Text>
        <Box marginTop={1}>
          <Select
            options={[
              {
                label: "Run `claude setup-token` (recommended)",
                value: "setup_token",
              },
              { label: "Paste OAuth token manually", value: "manual_oauth" },
              { label: "Provide ANTHROPIC_API_KEY", value: "manual_api_key" },
            ]}
            onChange={(value) => {
              if (value === "setup_token") {
                setSubStep("running_cli");
              } else if (value === "manual_oauth") {
                setSubStep("manual_oauth");
              } else if (value === "manual_api_key") {
                setSubStep("manual_api_key");
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
        <Text dimColor>This may take a moment.</Text>
      </Box>
    );
  }

  if (subStep === "confirm_token") {
    const masked = `${parsedToken.slice(0, 14)}...${parsedToken.slice(-4)}`;
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Token detected from CLI output:</Text>
        <Text color="green">{masked}</Text>
        {cliOutput ? (
          <Box marginTop={1}>
            <Text dimColor>CLI output: {cliOutput.slice(0, 200)}</Text>
          </Box>
        ) : null}
        <Box marginTop={1}>
          <Select
            options={[
              { label: "Use this token", value: "use" },
              { label: "Paste manually instead", value: "manual" },
            ]}
            onChange={(value) => {
              if (value === "use") {
                addLog("Claude OAuth token collected via CLI");
                goToNext({
                  claudeOAuthToken: parsedToken,
                  anthropicApiKey: "",
                  credentialType: "oauth",
                });
              } else {
                setSubStep("manual_oauth");
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (subStep === "manual_oauth") {
    return (
      <Box flexDirection="column" padding={1}>
        {cliError ? (
          <Box marginBottom={1} flexDirection="column">
            <Text color="red">Could not run claude setup-token: {cliError}</Text>
            <Text dimColor>Falling back to manual token entry.</Text>
          </Box>
        ) : null}
        <Text bold>Paste your CLAUDE_CODE_OAUTH_TOKEN:</Text>
        <TextInput
          placeholder="sk-ant-oat..."
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              addLog("Token cannot be empty.");
              return;
            }
            addLog("Claude OAuth token collected");
            goToNext({
              claudeOAuthToken: trimmed,
              anthropicApiKey: "",
              credentialType: "oauth",
            });
          }}
        />
      </Box>
    );
  }

  if (subStep === "manual_api_key") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Paste your ANTHROPIC_API_KEY:</Text>
        <TextInput
          placeholder="sk-ant-api..."
          onSubmit={(value) => {
            const trimmed = value.trim();
            if (!trimmed) {
              addLog("API key cannot be empty.");
              return;
            }
            addLog("Anthropic API key collected");
            goToNext({
              claudeOAuthToken: "",
              anthropicApiKey: trimmed,
              credentialType: "api_key",
            });
          }}
        />
      </Box>
    );
  }

  return null;
}
