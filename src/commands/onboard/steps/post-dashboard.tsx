import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { StepProps } from "../types.ts";

export function PostDashboardStep({ state, addLog, goToNext }: StepProps) {
  const apiUrl = `http://localhost:${state.apiPort || 3013}`;
  const dashboardUrl = `https://app.agent-swarm.dev?api_url=${apiUrl}&api_key=${state.apiKey}`;

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Open the swarm dashboard?</Text>
      <Text dimColor>{dashboardUrl}</Text>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Yes — open in browser", value: "yes" },
            { label: "No — skip", value: "no" },
          ]}
          onChange={async (value) => {
            if (value === "yes") {
              try {
                await Bun.$`open ${dashboardUrl}`.quiet();
                addLog("Opened dashboard in browser");
              } catch {
                addLog(`Open manually: ${dashboardUrl}`);
              }
            }
            goToNext();
          }}
        />
      </Box>
    </Box>
  );
}
