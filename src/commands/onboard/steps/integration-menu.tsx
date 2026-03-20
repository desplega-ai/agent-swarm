import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { OnboardState, StepProps } from "../types.ts";

type IntegrationKey = keyof OnboardState["integrations"];

const INTEGRATIONS: { key: IntegrationKey; label: string; description: string }[] = [
  { key: "github", label: "GitHub", description: "Push code, create PRs" },
  { key: "slack", label: "Slack", description: "Team notifications, chat" },
  { key: "gitlab", label: "GitLab", description: "Code hosting, CI/CD" },
  { key: "sentry", label: "Sentry", description: "Error tracking, monitoring" },
];

const CONTINUE_VALUE = "continue";

export function IntegrationMenuStep({ goToNext, addLog }: StepProps) {
  const [selections, setSelections] = useState<Record<IntegrationKey, boolean>>({
    github: false,
    slack: false,
    gitlab: false,
    sentry: false,
  });

  const options = [
    ...INTEGRATIONS.map((i) => ({
      label: `${selections[i.key] ? "[x]" : "[ ]"} ${i.label} \u2014 ${i.description}`,
      value: i.key,
    })),
    { label: "Continue \u2192", value: CONTINUE_VALUE },
  ];

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Which integrations do your agents need?</Text>
      <Text dimColor>Toggle integrations on/off, then select Continue.</Text>
      <Box marginTop={1}>
        <Select
          options={options}
          onChange={(value) => {
            if (value === CONTINUE_VALUE) {
              const enabled = INTEGRATIONS.filter((i) => selections[i.key]).map((i) => i.label);
              if (enabled.length > 0) {
                addLog(`Integrations: ${enabled.join(", ")}`);
              } else {
                addLog("Integrations: none");
              }
              goToNext({ integrations: { ...selections } });
              return;
            }
            const key = value as IntegrationKey;
            setSelections((prev) => ({ ...prev, [key]: !prev[key] }));
          }}
        />
      </Box>
    </Box>
  );
}
