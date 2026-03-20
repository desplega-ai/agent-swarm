import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { OnboardState, StepProps } from "../types.ts";

type IntegrationKey = keyof OnboardState["integrations"];

const INTEGRATIONS: { key: IntegrationKey; label: string; description: string }[] = [
  { key: "github", label: "GitHub", description: "Push code, create PRs, manage repos" },
  { key: "slack", label: "Slack", description: "Team notifications, task updates, chat" },
  { key: "gitlab", label: "GitLab", description: "Alternative to GitHub for code hosting" },
  { key: "sentry", label: "Sentry", description: "Error tracking and monitoring" },
];

export function IntegrationMenuStep({ state: _state, goToNext, addLog }: StepProps) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [selections, setSelections] = useState<Record<IntegrationKey, boolean>>({
    github: false,
    slack: false,
    gitlab: false,
    sentry: false,
  });

  if (currentIndex >= INTEGRATIONS.length) {
    // All integrations asked — should not render, but safety fallback
    return null;
  }

  // Safe because we guard currentIndex < INTEGRATIONS.length above
  const current = INTEGRATIONS[currentIndex]!;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Integration Setup</Text>
      <Text dimColor>Enable the integrations your agents will use.</Text>
      <Box marginTop={1} flexDirection="column">
        {/* Show previous selections */}
        {INTEGRATIONS.slice(0, currentIndex).map((integration) => (
          <Text key={integration.key} dimColor>
            {selections[integration.key] ? "+" : "-"} {integration.label} —{" "}
            {selections[integration.key] ? "enabled" : "skipped"}
          </Text>
        ))}
      </Box>
      <Box marginTop={1} flexDirection="column">
        <Text>
          Enable <Text bold>{current.label}</Text>? <Text dimColor>— {current.description}</Text>
        </Text>
        <Select
          options={[
            { label: "Yes", value: "yes" },
            { label: "No", value: "no" },
          ]}
          onChange={(value) => {
            const enabled = value === "yes";
            const updated = { ...selections, [current.key]: enabled };
            setSelections(updated);

            if (enabled) {
              addLog(`Integration enabled: ${current.label}`);
            }

            const nextIndex = currentIndex + 1;
            if (nextIndex >= INTEGRATIONS.length) {
              // All asked — advance
              goToNext({ integrations: updated });
            } else {
              setCurrentIndex(nextIndex);
            }
          }}
        />
      </Box>
    </Box>
  );
}
