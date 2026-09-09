import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useState } from "react";
import { normalizeBedrockModel } from "../non-interactive.ts";
import type { StepProps } from "../types.ts";

type SubStep =
  | "choose_method"
  | "running_cli"
  | "confirm_token"
  | "manual_oauth"
  | "manual_api_key";

const TOKEN_REGEX = /sk-ant-oat[^\s]+/;

export function HarnessCredentialsStep({ state, goToNext, addLog }: StepProps) {
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
    })().catch((err) => addLog(`Harness credential setup failed: ${err}`));

    return () => {
      cancelled = true;
    };
  }, [subStep, addLog]);

  if (state.provider !== "claude") {
    return <ProviderCredentialFields state={state} goToNext={goToNext} addLog={addLog} />;
  }

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

type ProviderCredentialProps = Pick<StepProps, "state" | "goToNext" | "addLog">;

function ProviderCredentialFields({ state, goToNext, addLog }: ProviderCredentialProps) {
  const [field, setField] = useState("key");
  const [values, setValues] = useState<Record<string, string>>({});

  const collect = (name: string, value: string, next: string) => {
    const trimmed = value.trim();
    if (!trimmed && name !== "awsSessionToken") {
      addLog("Credential value cannot be empty.");
      return;
    }
    setValues((current) => ({ ...current, [name]: trimmed }));
    setField(next);
  };

  if (state.provider === "openai") {
    return (
      <CredentialInput
        label="Paste your OPENAI_API_KEY:"
        placeholder="sk-..."
        onSubmit={(value) => {
          const trimmed = value.trim();
          if (!trimmed) return addLog("API key cannot be empty.");
          addLog("OpenAI API key collected");
          goToNext({ openaiApiKey: trimmed });
        }}
      />
    );
  }

  if (state.provider === "openrouter") {
    if (field === "key") {
      return (
        <CredentialInput
          label="Paste your OPENROUTER_API_KEY:"
          placeholder="sk-or-v1-..."
          onSubmit={(value) => collect("openrouterApiKey", value, "model")}
        />
      );
    }
    return (
      <CredentialInput
        label="OpenRouter model:"
        placeholder="openrouter/qwen/qwen3-coder-flash"
        hint="Press Enter to use openrouter/qwen/qwen3-coder-flash."
        allowEmpty
        onSubmit={(value) => {
          addLog("OpenRouter credentials collected");
          goToNext({
            openrouterApiKey: values.openrouterApiKey ?? "",
            modelOverride: value.trim() || "openrouter/qwen/qwen3-coder-flash",
          });
        }}
      />
    );
  }

  if (field === "key") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>How should AWS credentials be loaded?</Text>
        <Box marginTop={1}>
          <Select
            options={[
              { label: "AWS profile (~/.aws)", value: "profile" },
              { label: "Access key and secret", value: "access_key" },
            ]}
            onChange={(value) => setField(value === "profile" ? "awsProfile" : "awsAccessKeyId")}
          />
        </Box>
      </Box>
    );
  }

  if (field === "awsProfile") {
    return (
      <CredentialInput
        label="AWS profile name:"
        placeholder="default"
        onSubmit={(value) => collect("awsProfile", value, "awsRegion")}
      />
    );
  }

  if (field === "awsAccessKeyId") {
    return (
      <CredentialInput
        label="AWS_ACCESS_KEY_ID:"
        placeholder="AKIA..."
        onSubmit={(value) => collect("awsAccessKeyId", value, "awsSecretAccessKey")}
      />
    );
  }

  if (field === "awsSecretAccessKey") {
    return (
      <CredentialInput
        label="AWS_SECRET_ACCESS_KEY:"
        onSubmit={(value) => collect("awsSecretAccessKey", value, "awsSessionToken")}
      />
    );
  }

  if (field === "awsSessionToken") {
    return (
      <CredentialInput
        label="AWS_SESSION_TOKEN (optional):"
        hint="Press Enter to skip for long-lived credentials."
        allowEmpty
        onSubmit={(value) => collect("awsSessionToken", value, "awsRegion")}
      />
    );
  }

  if (field === "awsRegion") {
    return (
      <CredentialInput
        label="AWS_REGION:"
        placeholder="us-east-1"
        onSubmit={(value) => collect("awsRegion", value, "model")}
      />
    );
  }

  return (
    <CredentialInput
      label="Bedrock model id:"
      placeholder="anthropic.claude-sonnet-4-20250514-v1:0"
      hint="The amazon-bedrock/ prefix is added automatically."
      onSubmit={(value) => {
        const trimmed = value.trim();
        if (!trimmed) return addLog("Bedrock model id cannot be empty.");
        addLog("AWS Bedrock credentials collected (alpha)");
        goToNext({
          awsProfile: values.awsProfile ?? "",
          awsAccessKeyId: values.awsAccessKeyId ?? "",
          awsSecretAccessKey: values.awsSecretAccessKey ?? "",
          awsSessionToken: values.awsSessionToken ?? "",
          awsRegion: values.awsRegion ?? "",
          modelOverride: normalizeBedrockModel(trimmed),
        });
      }}
    />
  );
}

function CredentialInput({
  label,
  placeholder,
  hint,
  allowEmpty = false,
  onSubmit,
}: {
  label: string;
  placeholder?: string;
  hint?: string;
  allowEmpty?: boolean;
  onSubmit: (value: string) => void;
}) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>{label}</Text>
      {hint ? <Text dimColor>{hint}</Text> : null}
      <TextInput
        placeholder={placeholder}
        onSubmit={(value) => {
          if (!allowEmpty && !value.trim()) return;
          onSubmit(value);
        }}
      />
    </Box>
  );
}
