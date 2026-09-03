import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import type { StepProps } from "../types.ts";
import { type InstallProvider, PROVIDER_HARNESS } from "../types.ts";

export const PROVIDER_CAPABILITY_MATRIX_URL =
  "https://docs.agent-swarm.dev/docs/guides/provider-capability-matrix";

export function HarnessStep({ goToNext, addLog }: StepProps) {
  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Which LLM provider should run your agents?</Text>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Claude Code (Recommended)", value: "claude" },
            { label: "OpenAI", value: "openai" },
            { label: "OpenRouter", value: "openrouter" },
            { label: "AWS Bedrock (alpha)", value: "bedrock" },
          ]}
          onChange={(value) => {
            const provider = value as InstallProvider;
            addLog(`Provider: ${value}`);
            goToNext({ provider, harness: PROVIDER_HARNESS[provider] });
          }}
        />
      </Box>
      <Text dimColor>
        Alpha: session summaries, memory rating, spend tracking and model tiers may be missing on
        Bedrock.
      </Text>
      <Text dimColor>What each provider supports: {PROVIDER_CAPABILITY_MATRIX_URL}</Text>
    </Box>
  );
}
