import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep = "token" | "email";

export function IntegrationGitLabStep({ goToNext }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("token");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>GitLab Integration</Text>
      <Text dimColor>Alternative to GitHub for code hosting and CI/CD.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Create a Personal Access Token at{" "}
          <Text color="cyan" underline>
            gitlab.com/-/user_settings/personal_access_tokens
          </Text>
        </Text>
        <Text dimColor>Required scopes: api, read_repository, write_repository</Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {subStep === "token" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>GitLab Token (GITLAB_TOKEN):</Text>
          <TextInput
            key="gitlab-token"
            placeholder="glpat-..."
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
            <Text bold>GitLab Email (GITLAB_EMAIL):</Text>
            <TextInput
              key="gitlab-email"
              placeholder="you@example.com"
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError("Email is required.");
                  return;
                }
                setError("");
                goToNext({
                  gitlabToken: token,
                  gitlabEmail: trimmed,
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
