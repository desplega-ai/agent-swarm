import { Select, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../types.ts";

type HealthStatus = "waiting_api" | "waiting_agents" | "healthy" | "timeout";

interface AgentStatus {
  name: string;
  registered: boolean;
}

export function HealthCheckStep({ state, addLog, goToNext }: StepProps) {
  const [status, setStatus] = useState<HealthStatus>("waiting_api");
  const [elapsed, setElapsed] = useState(0);
  const [agents, setAgents] = useState<AgentStatus[]>([]);
  const executed = useRef(false);

  useEffect(() => {
    if (executed.current) return;
    executed.current = true;

    const apiUrl = `http://localhost:${state.apiPort || 3013}`;
    const apiTimeout = 60_000;
    const agentTimeout = 90_000;
    const pollInterval = 3_000;

    let cancelled = false;
    const start = Date.now();

    const poll = async () => {
      // Phase 1: Wait for API health
      while (!cancelled) {
        const now = Date.now() - start;
        setElapsed(Math.floor(now / 1000));

        if (now > apiTimeout) {
          setStatus("timeout");
          return;
        }

        try {
          const res = await fetch(`${apiUrl}/health`);
          if (res.ok) {
            addLog("API server is healthy");
            setStatus("waiting_agents");
            break;
          }
        } catch {
          // Not ready yet
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }

      // Phase 2: Wait for agents to register
      const expectedNames = Object.keys(state.agentIds);
      const agentStart = Date.now();

      while (!cancelled) {
        const now = Date.now() - agentStart;
        setElapsed(Math.floor((Date.now() - start) / 1000));

        if (now > agentTimeout) {
          addLog("Agent registration timed out — some agents may still be booting");
          setStatus("healthy"); // Continue anyway
          return;
        }

        try {
          const res = await fetch(`${apiUrl}/api/agents`, {
            headers: { Authorization: `Bearer ${state.apiKey}` },
          });
          if (res.ok) {
            const data = (await res.json()) as { agents: { name: string }[] };
            const registeredNames = new Set(data.agents.map((a) => a.name));
            const statuses = expectedNames.map((name) => ({
              name,
              registered: registeredNames.has(name),
            }));
            setAgents(statuses);

            if (statuses.every((s) => s.registered)) {
              addLog(`All ${statuses.length} agents registered`);
              setStatus("healthy");
              return;
            }
          }
        } catch {
          // API might have restarted
        }
        await new Promise((r) => setTimeout(r, pollInterval));
      }
    };

    poll();
    return () => {
      cancelled = true;
    };
  }, [state.agentIds, state.apiKey, state.apiPort, addLog]);

  useEffect(() => {
    if (status === "healthy") {
      const timer = setTimeout(() => goToNext(), 500);
      return () => clearTimeout(timer);
    }
  }, [status, goToNext]);

  if (status === "waiting_api") {
    return (
      <Box padding={1}>
        <Spinner label={`Waiting for API server... (${elapsed}s / 60s)`} />
      </Box>
    );
  }

  if (status === "waiting_agents") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">{"✓"} API server is healthy</Text>
        <Spinner label={`Waiting for agents to register... (${elapsed}s)`} />
        {agents.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {agents.map((a) => (
              <Text key={a.name} color={a.registered ? "green" : "yellow"}>
                {a.registered ? "✓" : "…"} {a.name}
              </Text>
            ))}
          </Box>
        )}
      </Box>
    );
  }

  if (status === "healthy") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">{"✓"} API server is healthy</Text>
        {agents.map((a) => (
          <Text key={a.name} color={a.registered ? "green" : "yellow"}>
            {a.registered ? "✓" : "…"} {a.name}
          </Text>
        ))}
      </Box>
    );
  }

  // Timeout
  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">{"✗"} API health check timed out after 60s</Text>
      <Text dimColor>Try: docker compose logs --tail 50</Text>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Retry", value: "retry" },
            { label: "Continue anyway", value: "continue" },
          ]}
          onChange={(value) => {
            if (value === "retry") {
              executed.current = false;
              setStatus("waiting_api");
              setElapsed(0);
            } else {
              goToNext();
            }
          }}
        />
      </Box>
    </Box>
  );
}
