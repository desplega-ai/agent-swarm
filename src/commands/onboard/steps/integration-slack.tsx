import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { SlackMode } from "../../../slack/config.ts";
import type { StepProps } from "../types.ts";

type SubStep = "manifest_options" | "app_created" | "mode" | "bot_token" | "credential";

const MANIFEST_URL =
  "https://raw.githubusercontent.com/desplega-ai/agent-swarm/main/slack-manifest.json";

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await Bun.$`echo ${text} | pbcopy`.quiet();
    return true;
  } catch {
    return false;
  }
}

export function IntegrationSlackStep({ goToNext }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("manifest_options");
  const [copied, setCopied] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [mode, setMode] = useState<SlackMode>("socket");
  const [error, setError] = useState("");

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Slack Integration</Text>
      <Text dimColor>Team notifications, task updates, and chat with agents.</Text>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {subStep === "manifest_options" && (
        <Box marginTop={1} flexDirection="column">
          <Text>To set up Slack, you need to create a Slack App using the provided manifest.</Text>
          <Box marginTop={1}>
            <Select
              options={[
                { label: "Copy manifest URL to clipboard", value: "copy" },
                { label: "Show manifest URL", value: "show" },
                { label: "Skip — I already have a Slack app", value: "skip" },
              ]}
              onChange={async (value) => {
                if (value === "copy") {
                  const ok = await copyToClipboard(MANIFEST_URL);
                  setCopied(ok);
                  setSubStep("app_created");
                } else if (value === "show") {
                  setCopied(false);
                  setSubStep("app_created");
                } else {
                  setSubStep("mode");
                }
              }}
            />
          </Box>
        </Box>
      )}

      {subStep === "app_created" && (
        <Box marginTop={1} flexDirection="column">
          {copied ? (
            <Text color="green">Manifest URL copied to clipboard!</Text>
          ) : (
            <Box flexDirection="column">
              <Text>Manifest URL:</Text>
              <Text color="cyan" underline>
                {MANIFEST_URL}
              </Text>
            </Box>
          )}
          <Box marginTop={1} flexDirection="column">
            <Text>Steps:</Text>
            <Text>
              1. Go to{" "}
              <Text color="cyan" underline>
                api.slack.com/apps
              </Text>{" "}
              and click "Create New App"
            </Text>
            <Text>2. Choose "From a manifest" and select your workspace</Text>
            <Text>3. Paste the manifest JSON (or use the URL above)</Text>
            <Text>4. Click "Create" and install to your workspace</Text>
          </Box>
          <Box marginTop={1}>
            <Select
              options={[{ label: "Continue — I've created the app", value: "continue" }]}
              onChange={() => setSubStep("mode")}
            />
          </Box>
        </Box>
      )}

      {subStep === "mode" && (
        <Box marginTop={1} flexDirection="column">
          <Text>Select the Slack transport:</Text>
          <Box marginTop={1}>
            <Select
              options={[
                { label: "Socket Mode (default)", value: "socket" },
                {
                  label: "HTTP (configuration only; receiver not installed yet)",
                  value: "http",
                },
              ]}
              onChange={(value) => {
                setMode(value as SlackMode);
                setSubStep("bot_token");
              }}
            />
          </Box>
        </Box>
      )}

      {subStep === "bot_token" && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            Find your Bot Token under <Text bold>OAuth & Permissions</Text> in the Slack app
            settings.
          </Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Bot Token (SLACK_BOT_TOKEN):</Text>
            <TextInput
              key="slack-bot-token"
              placeholder="xoxb-..."
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError("Bot token is required. Please enter it above.");
                  return;
                }
                if (!trimmed.startsWith("xoxb-")) {
                  setError("Bot token should start with xoxb- — please check and re-enter.");
                  return;
                }
                setError("");
                setBotToken(trimmed);
                setSubStep("credential");
              }}
            />
          </Box>
        </Box>
      )}

      {subStep === "credential" && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Bot Token: {botToken.slice(0, 10)}...</Text>
          <Box marginTop={1} flexDirection="column">
            {mode === "socket" ? (
              <>
                <Text>
                  Find your App-Level Token under{" "}
                  <Text bold>Basic Information → App-Level Tokens</Text>.
                </Text>
                <Text dimColor>Create one with connections:write scope if you don't have one.</Text>
              </>
            ) : (
              <Text>
                Find your Signing Secret under <Text bold>Basic Information → App Credentials</Text>
                .
              </Text>
            )}
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>
              {mode === "socket"
                ? "App Token (SLACK_APP_TOKEN):"
                : "Signing Secret (SLACK_SIGNING_SECRET):"}
            </Text>
            <TextInput
              key={`slack-${mode}-credential`}
              placeholder={mode === "socket" ? "xapp-..." : "signing secret"}
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError(
                    `${mode === "socket" ? "App token" : "Signing secret"} is required. Please enter it above.`,
                  );
                  return;
                }
                if (mode === "socket" && !trimmed.startsWith("xapp-")) {
                  setError("App token should start with xapp- — please check and re-enter.");
                  return;
                }
                setError("");
                goToNext({
                  slackBotToken: botToken,
                  slackMode: mode,
                  slackAppToken: mode === "socket" ? trimmed : "",
                  slackSigningSecret: mode === "http" ? trimmed : "",
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
