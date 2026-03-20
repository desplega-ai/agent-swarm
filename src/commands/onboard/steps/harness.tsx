import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { StepProps } from "../types.ts";

export function HarnessStep({ goToNext, addLog }: StepProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Which harness should run your agents?</Text>
      <Box marginTop={1}>
        <Select
          options={[{ label: "Claude Code (Recommended)", value: "claude" }]}
          onChange={() => {
            addLog("Harness: Claude Code");
            goToNext({ harness: "claude" });
          }}
        />
      </Box>
      <Text dimColor>Pi-mono — Coming soon</Text>
    </Box>
  );
}
