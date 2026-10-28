import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { buildOnboardDashboardUrl, maskDashboardUrlApiKey } from "../dashboard-url.ts";
import type { StepProps } from "../types.ts";

export function PostDashboardStep({ state, addLog, goToNext }: StepProps) {
  const apiUrl = `http://localhost:${state.apiPort || 3013}`;
  // camelCase params — the SPA ignores snake_case (see dashboard-url.ts).
  const dashboardUrl = buildOnboardDashboardUrl({ apiUrl, apiKey: state.apiKey });

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Open the swarm dashboard?</Text>
      <Text dimColor>{maskDashboardUrlApiKey(dashboardUrl)}</Text>
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
                addLog(`Open manually: ${maskDashboardUrlApiKey(dashboardUrl)}`);
              }
            }
            goToNext();
          }}
        />
      </Box>
    </Box>
  );
}
