import { randomBytes, randomUUID } from "node:crypto";
import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../types.ts";

export function CoreCredentialsStep({ state, goToNext, addLog }: StepProps) {
  const [apiKey, setApiKey] = useState("");
  const [agentIds, setAgentIds] = useState<Record<string, string>>({});
  const [ready, setReady] = useState(false);
  const generatedRef = useRef(false);

  useEffect(() => {
    if (generatedRef.current) return;
    generatedRef.current = true;

    const key = randomBytes(32).toString("hex").slice(0, 24);
    setApiKey(key);

    const ids: Record<string, string> = {};
    for (const service of state.services) {
      for (let i = 0; i < service.count; i++) {
        const suffix = service.count > 1 ? ` #${i + 1}` : "";
        const label = `${service.displayName}${suffix}`;
        ids[label] = randomUUID();
      }
    }
    setAgentIds(ids);

    const masked = `${key.slice(0, 4)}...${key.slice(-4)}`;
    addLog(`Generated API key: ${masked}`);
    addLog(`Generated ${Object.keys(ids).length} agent ID(s)`);

    // Brief pause so the user sees the summary, then advance
    const timer = setTimeout(() => {
      setReady(true);
    }, 1000);

    return () => clearTimeout(timer);
  }, [state.services, addLog]);

  useEffect(() => {
    if (!ready) return;
    goToNext({ apiKey, agentIds });
  }, [ready, apiKey, agentIds, goToNext]);

  const idEntries = Object.entries(agentIds);

  return (
    <Box flexDirection="column" padding={1}>
      <Text bold>Generating credentials...</Text>
      {apiKey && (
        <Box marginTop={1} flexDirection="column">
          <Text>
            API Key:{" "}
            <Text color="green">
              {apiKey.slice(0, 4)}...{apiKey.slice(-4)}
            </Text>
          </Text>
          {idEntries.length > 0 && (
            <Box flexDirection="column" marginTop={1}>
              <Text>Agent IDs:</Text>
              {idEntries.map(([label, id]) => (
                <Text key={id}>
                  {"  "}
                  {label}: <Text dimColor>{id}</Text>
                </Text>
              ))}
            </Box>
          )}
        </Box>
      )}
      {!ready && (
        <Box marginTop={1}>
          <Spinner label="Preparing next step..." />
        </Box>
      )}
    </Box>
  );
}
