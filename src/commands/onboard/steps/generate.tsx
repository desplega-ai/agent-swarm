import { Spinner } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import { generateCompose } from "../compose-generator.ts";
import { generateEnv } from "../env-generator.ts";
import type { StepProps } from "../types.ts";

interface ManifestConfig {
  presetId: string | null;
  deployType: string;
  harness: string;
  services: { template: string; displayName: string; count: number; role: string }[];
  integrations: Record<string, boolean>;
  agentIds: Record<string, string>;
  createdAt: string;
}

function generateManifest(state: {
  presetId: string | null;
  deployType: string;
  harness: string;
  services: { template: string; displayName: string; count: number; role: string }[];
  integrations: Record<string, boolean>;
  agentIds: Record<string, string>;
}): ManifestConfig {
  return {
    presetId: state.presetId,
    deployType: state.deployType,
    harness: state.harness,
    services: state.services.map((s) => ({
      template: s.template,
      displayName: s.displayName,
      count: s.count,
      role: s.role,
    })),
    integrations: { ...state.integrations },
    agentIds: { ...state.agentIds },
    createdAt: new Date().toISOString(),
  };
}

export function GenerateStep({ state, dryRun, addLog, goToNext, goToStep, goToError }: StepProps) {
  const executedRef = useRef(false);
  const [composePreview, setComposePreview] = useState<string | null>(null);
  const [envPreview, setEnvPreview] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (executedRef.current) return;
    executedRef.current = true;

    const run = async () => {
      const composeContent = generateCompose(state);
      const envContent = generateEnv(state);
      const manifest = generateManifest(state);

      if (dryRun) {
        const composeLines = composeContent.split("\n").slice(0, 30).join("\n");
        const envLines = envContent.split("\n").slice(0, 20).join("\n");
        setComposePreview(composeLines);
        setEnvPreview(envLines);

        addLog("Write docker-compose.yml", true);
        addLog("Write .env", true);
        addLog("Write .agent-swarm/config.json", true);
        // In dry-run, skip prereq/start/health — go straight to done
        goToStep("done");
        return;
      }

      // Write docker-compose.yml
      const composePath = `${state.outputDir}/docker-compose.yml`;
      await Bun.write(composePath, composeContent);
      addLog(`Wrote ${composePath}`);

      // Write .env
      const envPath = `${state.outputDir}/.env`;
      await Bun.write(envPath, envContent);
      addLog(`Wrote ${envPath}`);

      // Create .agent-swarm/ dir and write config.json
      await Bun.$`mkdir -p ${state.outputDir}/.agent-swarm`;
      const manifestPath = `${state.outputDir}/.agent-swarm/config.json`;
      await Bun.write(manifestPath, JSON.stringify(manifest, null, 2));
      addLog(`Wrote ${manifestPath}`);

      // Add to .gitignore if in a git repo
      try {
        const result = await Bun.$`git -C ${state.outputDir} rev-parse --show-toplevel`.quiet();
        if (result.exitCode === 0) {
          const gitRoot = result.text().trim();
          const gitignorePath = `${gitRoot}/.gitignore`;
          const gitignoreFile = Bun.file(gitignorePath);

          let content = "";
          if (await gitignoreFile.exists()) {
            content = await gitignoreFile.text();
          }

          const entriesToAdd: string[] = [];
          if (!content.includes(".env")) {
            entriesToAdd.push(".env");
          }
          if (!content.includes(".agent-swarm/")) {
            entriesToAdd.push(".agent-swarm/");
          }

          if (entriesToAdd.length > 0) {
            const block = `\n# Added by agent-swarm onboard\n${entriesToAdd.join("\n")}\n`;
            await Bun.write(gitignorePath, content + block);
            addLog(`Added to .gitignore: ${entriesToAdd.join(", ")}`);
          }
        }
      } catch {
        // Not a git repo — skip
      }

      setDone(true);
    };

    run().catch((err) => goToError(String(err)));
  }, [state, dryRun, addLog, goToStep, goToError]);

  useEffect(() => {
    if (!done) return;
    goToNext();
  }, [done, goToNext]);

  if (dryRun && composePreview != null && envPreview != null) {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="yellow">
          DRY-RUN — File previews:
        </Text>

        <Box marginTop={1} flexDirection="column">
          <Text bold>docker-compose.yml (first 30 lines):</Text>
          <Text dimColor>{composePreview}</Text>
        </Box>

        <Box marginTop={1} flexDirection="column">
          <Text bold>.env (first 20 lines):</Text>
          <Text dimColor>{envPreview}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Spinner label="Generating files..." />
    </Box>
  );
}
