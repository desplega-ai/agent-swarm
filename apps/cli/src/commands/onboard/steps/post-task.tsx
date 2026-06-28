import { Select, TextInput } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../types.ts";

type SubStep = "ask" | "input" | "sending" | "sent";

export function PostTaskStep({ state, addLog, goToNext }: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("ask");
  const [sentTask, setSentTask] = useState("");

  const leadService = state.services.find((s) => s.isLead);
  const leadName = leadService ? "lead" : Object.keys(state.agentIds)[0] || "";
  const leadAgentId = state.agentIds[leadName] || "";

  if (subStep === "ask") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>Send your first task to the swarm?</Text>
        <Box marginTop={1}>
          <Select
            options={[
              { label: "Yes — send a task", value: "yes" },
              { label: "Skip", value: "skip" },
            ]}
            onChange={(value) => {
              if (value === "yes") {
                setSubStep("input");
              } else {
                goToNext();
              }
            }}
          />
        </Box>
      </Box>
    );
  }

  if (subStep === "input") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold>What should the swarm do?</Text>
        <Box marginTop={1}>
          <TextInput
            placeholder="Say hello to the swarm"
            onSubmit={async (value) => {
              const task = value.trim() || "Say hello to the swarm";
              setSubStep("sending");
              setSentTask(task);
              try {
                const res = await fetch(`http://localhost:${state.apiPort || 3013}/api/tasks`, {
                  method: "POST",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${state.apiKey}`,
                  },
                  body: JSON.stringify({
                    task,
                    agentId: leadAgentId || undefined,
                  }),
                });
                if (!res.ok) {
                  const text = await res.text();
                  addLog(`Task API returned ${res.status}: ${text}`);
                } else {
                  addLog("Task sent successfully");
                }
              } catch (err) {
                addLog(`Failed to send task: ${err}`);
              }
              setSubStep("sent");
            }}
          />
        </Box>
      </Box>
    );
  }

  if (subStep === "sending" || subStep === "sent") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">
          {"✓"} Task sent: "{sentTask}"
        </Text>
        <Text dimColor>Check the dashboard to see it get picked up.</Text>
        {subStep === "sent" && <DoneTimer goToNext={goToNext} />}
      </Box>
    );
  }

  return null;
}

function DoneTimer({ goToNext }: { goToNext: () => void }) {
  const executed = useRef(false);
  useEffect(() => {
    if (executed.current) return;
    executed.current = true;
    const timer = setTimeout(() => goToNext(), 1000);
    return () => clearTimeout(timer);
  }, [goToNext]);
  return null;
}
