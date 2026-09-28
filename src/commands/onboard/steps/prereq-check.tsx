import { Select, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  CONTAINER_ENGINE_LABELS,
  ENGINE_INSTALL_HINTS,
  type EngineCheck,
  type EngineResolution,
  resolveContainerEngine,
} from "../container-engine.ts";
import type { StepProps } from "../types.ts";

type CheckStatus = "checking" | "passed" | "failed";

interface CheckResult {
  engine: EngineResolution;
  ports: { ok: boolean; conflicts?: string[] };
}

export function PrereqCheckStep({ state, addLog, goToNext, goToStep, goToError }: StepProps) {
  const [status, setStatus] = useState<CheckStatus>("checking");
  const [result, setResult] = useState<CheckResult | null>(null);
  const executed = useRef(false);

  useEffect(() => {
    if (executed.current) return;
    executed.current = true;

    const run = async () => {
      const res: CheckResult = {
        engine: await resolveContainerEngine(state.containerEngine),
        ports: { ok: true },
      };

      // Check ports
      const portsToCheck = [3013];
      const agentCount = state.services.reduce((sum, s) => sum + s.count, 0);
      for (let i = 0; i < agentCount; i++) {
        portsToCheck.push(3201 + i);
      }

      const conflicts: string[] = [];
      for (const port of portsToCheck) {
        try {
          const out = await Bun.$`lsof -i :${port} -t`.quiet();
          if (out.exitCode === 0 && out.text().trim()) {
            conflicts.push(`Port ${port} is in use (PID: ${out.text().trim().split("\n")[0]})`);
          }
        } catch {
          // Port is free
        }
      }
      if (conflicts.length > 0) {
        res.ports = { ok: false, conflicts };
      }

      setResult(res);

      if (res.engine.ok && res.ports.ok) {
        addLog(`Container engine: ${CONTAINER_ENGINE_LABELS[res.engine.engine]}`);
        addLog("All prerequisites met");
        setStatus("passed");
      } else {
        setStatus("failed");
      }
    };

    run().catch((err) => goToError(err.message));
  }, [state.services, state.containerEngine, addLog, goToError]);

  // Auto-advance on pass
  useEffect(() => {
    if (status === "passed" && result?.engine.ok) {
      const engine = result.engine.engine;
      const timer = setTimeout(() => goToNext({ containerEngine: engine }), 500);
      return () => clearTimeout(timer);
    }
  }, [status, result, goToNext]);

  if (status === "checking") {
    return (
      <Box padding={1}>
        <Spinner label="Checking prerequisites..." />
      </Box>
    );
  }

  if (status === "passed" && result?.engine.ok) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">
          {"✓"} {result.engine.probe.binary.version}
        </Text>
        <Text color="green">
          {"✓"} {result.engine.probe.compose.version}
        </Text>
        <Text color="green">{"✓"} All ports available</Text>
      </Box>
    );
  }

  const probe = result?.engine.probe ?? null;
  const engineLabel = probe ? CONTAINER_ENGINE_LABELS[probe.engine] : "Container engine";

  // Failed
  return (
    <Box flexDirection="column" padding={1}>
      {result && !result.engine.ok && !result.engine.engine ? (
        <Box flexDirection="column">
          <Text color="red">
            {"✗"} {result.engine.error}
          </Text>
          <Text dimColor> {ENGINE_INSTALL_HINTS.docker}</Text>
          <Text dimColor> or {ENGINE_INSTALL_HINTS.podman}</Text>
        </Box>
      ) : (
        <>
          <CheckLine label={engineLabel} check={probe?.binary} />
          {probe?.binary.ok ? (
            <CheckLine label={`${engineLabel} Compose`} check={probe.compose} />
          ) : null}
        </>
      )}
      {result?.ports.ok ? (
        <Text color="green">{"✓"} All ports available</Text>
      ) : (
        <Box flexDirection="column">
          <Text color="red">{"✗"} Port conflicts:</Text>
          {result?.ports.conflicts?.map((c) => (
            <Text key={c} dimColor>
              {" "}
              {c}
            </Text>
          ))}
        </Box>
      )}
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Retry checks", value: "retry" },
            { label: "Skip — just keep the generated files", value: "skip" },
          ]}
          onChange={(value) => {
            if (value === "retry") {
              executed.current = false;
              setStatus("checking");
              setResult(null);
            } else {
              goToStep("done");
            }
          }}
        />
      </Box>
    </Box>
  );
}

function CheckLine({ label, check }: { label: string; check: EngineCheck | undefined }) {
  if (check?.ok) {
    return (
      <Text color="green">
        {"✓"} {check.version}
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color="red">
        {"✗"} {label}: {check?.error}
      </Text>
      {check?.hint ? <Text dimColor> {check.hint}</Text> : null}
    </Box>
  );
}
