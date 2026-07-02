import { TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep = "token" | "org";

export function IntegrationSentryStep({ goToNext }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("token");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Sentry Integration</Text>
      <Text dimColor>Error tracking and monitoring for your agents.</Text>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Create an Auth Token at{" "}
          <Text color="cyan" underline>
            sentry.io/settings/auth-tokens/
          </Text>
        </Text>
        <Text dimColor>Required scopes: project:read, org:read, event:read</Text>
      </Box>

      {error && (
        <Box marginTop={1}>
          <Text color="red">{error}</Text>
        </Box>
      )}

      {subStep === "token" && (
        <Box marginTop={1} flexDirection="column">
          <Text bold>Sentry Auth Token (SENTRY_AUTH_TOKEN):</Text>
          <TextInput
            key="sentry-token"
            placeholder="sntrys_..."
            onSubmit={(value) => {
              const trimmed = value.trim();
              if (!trimmed) {
                setError("Auth token is required.");
                return;
              }
              setError("");
              setToken(trimmed);
              setSubStep("org");
            }}
          />
        </Box>
      )}

      {subStep === "org" && (
        <Box marginTop={1} flexDirection="column">
          <Text dimColor>Token: {token.slice(0, 10)}...</Text>
          <Box marginTop={1} flexDirection="column">
            <Text bold>Sentry Organization (SENTRY_ORG):</Text>
            <TextInput
              key="sentry-org"
              placeholder="my-org"
              onSubmit={(value) => {
                const trimmed = value.trim();
                if (!trimmed) {
                  setError("Organization is required.");
                  return;
                }
                setError("");
                goToNext({
                  sentryToken: token,
                  sentryOrg: trimmed,
                });
              }}
            />
          </Box>
        </Box>
      )}
    </Box>
  );
}
