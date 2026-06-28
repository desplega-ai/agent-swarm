import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { getPresetById } from "../presets.ts";
import type { StepProps } from "../types.ts";

export function ReviewStep({ state, dryRun, goToNext, goToStep }: StepProps) {
  const preset = state.presetId ? getPresetById(state.presetId) : null;
  const totalAgents = state.services.reduce((sum, s) => sum + s.count, 0);

  const enabledIntegrations = Object.entries(state.integrations)
    .filter(([, v]) => v)
    .map(([k]) => k);

  const maskedKey = state.apiKey ? `${state.apiKey.slice(0, 8)}...` : "(not set)";

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Review Configuration</Text>
      <Text dimColor>Confirm before generating files.</Text>

      {dryRun && (
        <Box marginTop={1}>
          <Text color="yellow" bold>
            DRY-RUN MODE — files will NOT be written
          </Text>
        </Box>
      )}

      <Box marginTop={1} flexDirection="column">
        <Text>
          Deploy type: <Text color="cyan">{state.deployType}</Text>
        </Text>
        <Text>
          Preset: <Text color="cyan">{preset ? preset.name : (state.presetId ?? "custom")}</Text>
        </Text>
        <Text>
          Services: <Text color="cyan">{totalAgents}</Text>
        </Text>
        {state.services.map((svc) => (
          <Text key={svc.template} dimColor>
            {"  "}- {svc.displayName} x{svc.count} ({svc.template})
          </Text>
        ))}
        <Text>
          Harness: <Text color="cyan">{state.harness}</Text>
        </Text>
        <Text>
          Integrations:{" "}
          <Text color="cyan">
            {enabledIntegrations.length > 0 ? enabledIntegrations.join(", ") : "none"}
          </Text>
        </Text>
        <Text>
          Output directory: <Text color="cyan">{state.outputDir}</Text>
        </Text>
        <Text>
          API key: <Text color="cyan">{maskedKey}</Text>
        </Text>
      </Box>

      <Box marginTop={1} flexDirection="column">
        <Text bold>What would you like to do?</Text>
        <Select
          options={[
            { label: "Generate files and start", value: "generate" },
            { label: "Go back to integrations", value: "back" },
            { label: "Cancel", value: "cancel" },
          ]}
          onChange={(value) => {
            if (value === "generate") {
              goToNext();
            } else if (value === "back") {
              goToStep("integration_menu");
            } else {
              goToStep("done");
            }
          }}
        />
      </Box>
    </Box>
  );
}
