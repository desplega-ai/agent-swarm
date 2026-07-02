import { randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:net";
import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../types.ts";

/** Find an available port, starting from the preferred one. */
async function findAvailablePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(preferred, () => {
      server.close(() => resolve(preferred));
    });
    server.on("error", () => {
      // Port is in use, try a random one
      const server2 = createServer();
      server2.listen(0, () => {
        const addr = server2.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        server2.close(() => resolve(port));
      });
    });
  });
}

export function CoreCredentialsStep({ state, goToNext, addLog }: StepProps) {
  const [apiKey, setApiKey] = useState("");
  const [agentIds, setAgentIds] = useState<Record<string, string>>({});
  const [apiPort, setApiPort] = useState(0);
  const [ready, setReady] = useState(false);
  const generatedRef = useRef(false);

  useEffect(() => {
    if (generatedRef.current) return;
    generatedRef.current = true;

    const generate = async () => {
      const key = randomBytes(32).toString("hex").slice(0, 24);
      setApiKey(key);

      const ids: Record<string, string> = {};
      for (const service of state.services) {
        for (let i = 0; i < service.count; i++) {
          const suffix = service.count > 1 ? `-${i + 1}` : "";
          const name = service.isLead ? "lead" : `worker-${service.role}${suffix}`;
          ids[name] = randomUUID();
        }
      }
      setAgentIds(ids);

      // Find available port (prefer 3013)
      const port = await findAvailablePort(3013);
      setApiPort(port);

      const masked = `${key.slice(0, 4)}...${key.slice(-4)}`;
      addLog(`Generated API key: ${masked}`);
      addLog(`Generated ${Object.keys(ids).length} agent ID(s)`);
      addLog(`API port: ${port}${port !== 3013 ? " (3013 was in use)" : ""}`);

      setTimeout(() => setReady(true), 1000);
    };

    generate();
  }, [state.services, addLog]);

  useEffect(() => {
    if (!ready) return;
    goToNext({ apiKey, agentIds, apiPort });
  }, [ready, apiKey, agentIds, apiPort, goToNext]);

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
          {apiPort > 0 && (
            <Text>
              API Port: <Text color="green">{apiPort}</Text>
              {apiPort !== 3013 && <Text dimColor> (3013 was in use)</Text>}
            </Text>
          )}
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
