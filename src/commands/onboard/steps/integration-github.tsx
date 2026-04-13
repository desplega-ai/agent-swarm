import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep = "token" | "email" | "name";

export function IntegrationGitHubStep({ goToNext }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("token");
  const [token, setToken] = useState("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>GitHub Integration</Text>
      <Text dimColor>Lets agents push code, create PRs, and manage repositories.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Create a Personal Access Token at{" "}
          <Text color="cyan" underline>
            github.com/settings/tokens
          </Text>
        </Text>
        <Text dimColor>Required scope: repo</Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {subStep === "token" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>GitHub Token (GITHUB_TOKEN):</Text>
          <TextInput
            key="github-token"
            placeholder="ghp_..."
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                setError("Token is required.");
                return;
              }
              setError("");
              setToken(trimmed);
              setSubStep("email");
            }}
          />
        </Box>
      )}

      {subStep === "email" && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Token: {token.slice(0, 8)}...</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>GitHub Email (GITHUB_EMAIL):</Text>
            <TextInput
              key="github-email"
              placeholder="you@example.com"
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError("Email is required.");
                  return;
                }
                setError("");
                setEmail(trimmed);
                setSubStep("name");
              }}
            />
          </Box>
        </Box>
      )}

      {subStep === "name" && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Token: {token.slice(0, 8)}...</Text>
          <Text dimColor>Email: {email}</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>GitHub Name (GITHUB_NAME):</Text>
            <TextInput
              key="github-name"
              placeholder="Your Name"
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError("Name is required.");
                  return;
                }
                setError("");
                goToNext({
                  githubToken: token,
                  githubEmail: email,
                  githubName: trimmed,
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
