import { Select } from "@inkjs/ui";
import { Box, Text } from "ink";
import { useEffect, useRef, useState } from "react";
import type { TemplateConfig } from "../../../../templates/schema.ts";
import { fetchTemplateList } from "../templates.ts";
import type { ServiceEntry, StepProps } from "../types.ts";

type SubStep = "loading" | "picking" | "confirming";

export function CustomTemplatesStep({
  state: _state,
  dryRun,
  addLog,
  goToNext,
  goToError,
}: StepProps) {
  const [subStep, setSubStep] = useState<SubStep>("loading");
  const [templates, setTemplates] = useState<TemplateConfig[]>([]);
  const [services, setServices] = useState<ServiceEntry[]>([]);
  const fetchedRef = useRef(false);

  // Fetch templates on mount
  useEffect(() => {
    if (fetchedRef.current) return;
    fetchedRef.current = true;

    const load = async () => {
      addLog("Fetching templates from registry...");
      try {
        const list = await fetchTemplateList();
        if (list.length === 0) {
          goToError("No templates found in the registry.");
          return;
        }
        setTemplates(list);
        setSubStep("picking");
        addLog(`Found ${list.length} templates`);
      } catch (err) {
        goToError(err instanceof Error ? err.message : String(err));
      }
    };

    load();
  }, [addLog, goToError]);

  if (subStep === "loading") {
    return (
      <Box flexDirection="column" padding={1}>
        <Text dimColor>Loading templates from registry...</Text>
      </Box>
    );
  }

  if (subStep === "picking") {
    const leadTemplates = templates.filter((t) => t.agentDefaults.isLead);
    const workerTemplates = templates.filter((t) => !t.agentDefaults.isLead);

    const options = [
      ...leadTemplates.map((t) => ({
        label: `[Lead] ${t.displayName} — ${t.description}`,
        value: t.name,
      })),
      ...workerTemplates.map((t) => ({
        label: `${t.displayName} — ${t.description}`,
        value: t.name,
      })),
    ];

    return (
      <Box flexDirection="column" padding={1}>
        {services.length > 0 && (
          <Box flexDirection="column" marginBottom={1}>
            <Text bold>Selected services:</Text>
            {services.map((s) => (
              <Text key={s.template}>
                {"  "}- {s.displayName} ({s.template}){s.isLead ? " [lead]" : ""}
              </Text>
            ))}
          </Box>
        )}
        <Text bold>Add a service template{services.length > 0 ? " (or select Done)" : ""}:</Text>
        <Box marginTop={1}>
          <Select
            options={[
              ...(services.length > 0
                ? [{ label: "Done — finish selecting", value: "__done__" }]
                : []),
              ...options,
            ]}
            onChange={(value) => {
              if (value === "__done__") {
                setSubStep("confirming");
                return;
              }

              const tpl = templates.find((t) => t.name === value);
              if (!tpl) return;

              // Avoid adding the same template twice
              if (services.some((s) => s.template === tpl.name)) {
                addLog(`Template "${tpl.displayName}" is already selected.`);
                return;
              }

              const entry: ServiceEntry = {
                template: tpl.name,
                displayName: tpl.displayName,
                count: 1,
                role: tpl.agentDefaults.role,
                isLead: tpl.agentDefaults.isLead ?? false,
              };

              setServices((prev) => [...prev, entry]);
              addLog(`Added: ${tpl.displayName}`);
            }}
          />
        </Box>
      </Box>
    );
  }

  if (subStep === "confirming") {
    const hasLead = services.some((s) => s.isLead);

    return (
      <Box flexDirection="column" padding={1}>
        <Box flexDirection="column" marginBottom={1}>
          <Text bold>Selected services:</Text>
          {services.map((s) => (
            <Text key={s.template}>
              {"  "}- {s.displayName} ({s.template}){s.isLead ? " [lead]" : ""}
            </Text>
          ))}
        </Box>
        {!hasLead && (
          <Box marginBottom={1}>
            <Text color="yellow">
              Warning: No lead agent selected. A lead coordinates task delegation.
            </Text>
          </Box>
        )}
        <Text bold>Confirm selection?</Text>
        <Box marginTop={1}>
          <Select
            options={[
              { label: "Confirm and continue", value: "confirm" },
              { label: "Go back and add more", value: "back" },
            ]}
            onChange={(value) => {
              if (value === "back") {
                setSubStep("picking");
                return;
              }
              addLog(
                dryRun
                  ? `[DRY-RUN] Would use ${services.length} custom templates`
                  : `Using ${services.length} custom templates`,
              );
              goToNext({ services });
            }}
          />
        </Box>
      </Box>
    );
  }

  return null;
}
