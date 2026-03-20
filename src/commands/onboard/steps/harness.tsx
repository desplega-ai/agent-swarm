import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useState } from "react";
import type { StepProps } from "../types.ts";

export function HarnessStep({ goToNext, addLog }: StepProps) {
  const [piSelected, setPiSelected] = useState(false);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Which harness should run your agents?</Text>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Claude Code (Recommended)", value: "claude" },
            { label: "Pi-mono — Coming soon", value: "pi" },
          ]}
          onChange={(value) => {
            if (value === "pi") {
              addLog("Pi-mono support will be available in a future release.");
              setPiSelected(true);
              return;
            }
            addLog("Harness: Claude Code");
            goToNext({ harness: "claude" });
          }}
        />
      </Box>
      {piSelected && (
        <Box marginTop={1}>
          <Text color="yellow">Pi-mono support will be available in a future release.</Text>
        </Box>
      )}
    </Box>
  );
}
