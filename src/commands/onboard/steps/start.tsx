import { Select, Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { StepProps } from "../types.ts";

type StartStatus = "starting" | "success" | "failed";

export function StartStep({ state, addLog, goToNext }: StepProps) {
  const [status, setStatus] = useState<StartStatus>("starting");
  const [errorMsg, setErrorMsg] = useState("");
  const executed = useRef(false);

  useEffect(() => {
    if (executed.current) return;
    executed.current = true;

    const run = async () => {
      addLog("Running docker compose up -d...");
      try {
        const result = await Bun.$`docker compose --env-file .env up -d`
          .cwd(state.outputDir)
          .quiet();

        if (result.exitCode === 0) {
          addLog("Docker stack started successfully");
          setStatus("success");
        } else {
          const stderr = result.stderr.toString().trim();
          setErrorMsg(stderr || "docker compose up failed");
          setStatus("failed");
        }
      } catch (err) {
        setErrorMsg(err instanceof Error ? err.message : String(err));
        setStatus("failed");
      }
    };

    run();
  }, [state.outputDir, addLog]);

  useEffect(() => {
    if (status === "success") {
      const timer = setTimeout(() => goToNext(), 500);
      return () => clearTimeout(timer);
    }
  }, [status, goToNext]);

  if (status === "starting") {
    return (
      <Box padding={1}>
        <Spinner label="Starting Docker stack..." />
      </Box>
    );
  }

  if (status === "success") {
    return (
      <Box padding={1}>
        <Text color="green">{"✓"} Docker stack started</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Text color="red">{"✗"} Failed to start Docker stack</Text>
      <Text dimColor>{errorMsg}</Text>
      <Box marginTop={1}>
        <Select
          options={[
            { label: "Retry", value: "retry" },
            { label: "View logs (docker compose logs)", value: "logs" },
            { label: "Skip", value: "skip" },
          ]}
          onChange={async (value) => {
            if (value === "retry") {
              executed.current = false;
              setStatus("starting");
              setErrorMsg("");
            } else if (value === "logs") {
              try {
                const logs = await Bun.$`docker compose logs --tail 30`
                  .cwd(state.outputDir)
                  .quiet();
                addLog(logs.text());
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
