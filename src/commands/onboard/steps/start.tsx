import { Select, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import {
  CONTAINER_ENGINE_LABELS,
  composeArgv,
  composeCommandText,
  defaultCommandRunner,
  engineForCommands,
} from "../container-engine.ts";
import type { StepProps } from "../types.ts";

type StartStatus = "starting" | "success" | "failed";

export function StartStep({ state, addLog, goToNext }: StepProps) {
  const [status, setStatus] = useState<StartStatus>("starting");
  const [errorMsg, setErrorMsg] = useState("");
  const executed = useRef(false);
  const engine = engineForCommands(state.containerEngine);
  const engineLabel = CONTAINER_ENGINE_LABELS[engine];

  useEffect(() => {
    if (executed.current) return;
    executed.current = true;

    const run = async () => {
      addLog(`Running ${composeCommandText(engine, "--env-file .env up -d")}...`);
      try {
        const result = await defaultCommandRunner(
          composeArgv(engine, ["--env-file", ".env", "up", "-d"]),
          { cwd: state.outputDir },
        );

        if (result.exitCode === 0) {
          addLog(`${engineLabel} stack started successfully`);
          setStatus("success");
        } else {
          const stderr = result.stderr.trim();
          setErrorMsg(stderr || `${composeCommandText(engine, "up")} failed`);
          setStatus("failed");
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("failed");
      }
    };

    run().catch((err) => addLog(`Start failed: ${err}`));
  }, [state.outputDir, engine, engineLabel, addLog]);

  useEffect(() => {
    if (status === "success") {
      const timer = setTimeout(() => goToNext(), 500);
      return () => clearTimeout(timer);
    }
  }, [status, goToNext]);

  if (status === "starting") {
    return (
      <Box padding={1}>
        <Spinner label={`Starting ${engineLabel} stack...`} />
      </Box>
    );
  }

  if (status === "success") {
    return (
      <Box padding={1}>
        <Text color="green">
          {"✓"} {engineLabel} stack started
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">
        {"✗"} Failed to start {engineLabel} stack
      </Text>
      <Text dimColor>{errorMsg}</Text>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Retry", value: "retry" },
            { label: `View logs (${composeCommandText(engine, "logs")})`, value: "logs" },
            { label: "Skip", value: "skip" },
          ]}
          onChange={async (value) => {
            if (value === "retry") {
              executed.current = false;
              setStatus("starting");
              setErrorMsg("");
            } else if (value === "logs") {
              try {
                const logs = await defaultCommandRunner(
                  composeArgv(engine, ["logs", "--tail", "30"]),
                  { cwd: state.outputDir },
                );
                addLog(logs.stdout || logs.stderr);
              } catch {
                addLog("Failed to fetch logs");
              }
            } else {
              goToNext();
            }
          }}
        />
      </Box>
    </Box>
  );
}
