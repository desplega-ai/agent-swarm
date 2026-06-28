import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep = "manifest_options" | "app_created" | "bot_token" | "app_token";

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
                  setSubStep("bot_token");
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
              onChange={() => setSubStep("bot_token")}
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
                setSubStep("app_token");
              }}
            />
          </Box>
        </Box>
      )}

      {subStep === "app_token" && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Bot Token: {botToken.slice(0, 10)}...</Text>
          <Box marginTop={1} flexDirection="column">
            <Text>
              Find your App-Level Token under <Text bold>Basic Information → App-Level Tokens</Text>
              .
            </Text>
            <Text dimColor>Create one with connections:write scope if you don't have one.</Text>
          </Box>
          <Box marginTop={1} flexDirection="column">
            <Text bold>App Token (SLACK_APP_TOKEN):</Text>
            <TextInput
              key="slack-app-token"
              placeholder="xapp-..."
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError("App token is required. Please enter it above.");
                  return;
                }
                if (!trimmed.startsWith("xapp-")) {
                  setError("App token should start with xapp- — please check and re-enter.");
                  return;
                }
                setError("");
                goToNext({
                  slackBotToken: botToken,
                  slackAppToken: trimmed,
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
