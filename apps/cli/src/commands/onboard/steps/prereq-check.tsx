import { Select, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../types.ts";

type CheckStatus = "checking" | "passed" | "failed";

interface CheckResult {
  docker: { ok: boolean; version?: string; error?: string };
  compose: { ok: boolean; version?: string; error?: string };
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
        docker: { ok: false },
        compose: { ok: false },
        ports: { ok: true },
      };

      // Check Docker
      try {
        const out = await Bun.$`docker --version`.quiet();
        if (out.exitCode === 0) {
          res.docker = { ok: true, version: out.text().trim() };
        } else {
          res.docker = { ok: false, error: "Docker exited with non-zero status" };
        }
      } catch {
        res.docker = { ok: false, error: "Docker not found" };
      }

      // Check Docker Compose
      try {
        const out = await Bun.$`docker compose version`.quiet();
        if (out.exitCode === 0) {
          res.compose = { ok: true, version: out.text().trim() };
        } else {
          res.compose = { ok: false, error: "Docker Compose not found" };
        }
      } catch {
        res.compose = { ok: false, error: "Docker Compose v2 not found" };
      }

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

      if (res.docker.ok && res.compose.ok && res.ports.ok) {
        addLog("All prerequisites met");
        setStatus("passed");
      } else {
        setStatus("failed");
      }
    };

    run().catch((err) => goToError(err.message));
  }, [state.services, addLog, goToError]);

  // Auto-advance on pass
  useEffect(() => {
    if (status === "passed") {
      const timer = setTimeout(() => goToNext(), 500);
      return () => clearTimeout(timer);
    }
  }, [status, goToNext]);

  if (status === "checking") {
    return (
      <Box padding={1}>
        <Spinner label="Checking prerequisites..." />
      </Box>
    );
  }

  if (status === "passed" && result) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text color="green">
          {"✓"} {result.docker.version}
        </Text>
        <Text color="green">
          {"✓"} {result.compose.version}
        </Text>
        <Text color="green">{"✓"} All ports available</Text>
      </Box>
    );
  }

  // Failed
  return (
    <Box flexDirection="column" padding={1}>
      {result?.docker.ok ? (
        <Text color="green">
          {"✓"} {result.docker.version}
        </Text>
      ) : (
        <Box flexDirection="column">
          <Text color="red">
            {"✗"} Docker: {result?.docker.error}
          </Text>
          <Text dimColor>
            {" "}
            Install: brew install --cask docker (macOS) or https://docs.docker.com/get-docker/
          </Text>
        </Box>
      )}
      {result?.compose.ok ? (
        <Text color="green">
          {"✓"} {result.compose.version}
        </Text>
      ) : (
        <Text color="red">
          {"✗"} Docker Compose v2: {result?.compose.error}
        </Text>
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
