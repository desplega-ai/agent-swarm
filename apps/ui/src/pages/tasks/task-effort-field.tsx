import { useEffect } from "react";
import { useResolvedConfigs } from "@/api/hooks/use-config-api";
import { useModelTiers } from "@/api/hooks/use-model-tiers";
import { useModelsCatalog } from "@/api/hooks/use-models-catalog";
import type { Agent } from "@/api/types";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { effortAllowed, taskEffortOptions } from "@/lib/task-effort";

/**
 * The Reasoning Effort picker of the Create Task dialog. It offers the levels
 * the agent's harness accepts on the model the task will run (`taskEffortOptions`),
 * turns off for a harness with no effort control, and clears a chosen level the
 * agent or Model Tier change makes unsupported.
 */
export function TaskEffortField({
  agent,
  tier,
  value,
  onChange,
  enabled,
}: {
  /** The agent the task goes to. */
  agent: Pick<Agent, "id" | "harnessProvider" | "credStatus"> | undefined;
  /** The Model Tier picked on the task, `""` for none. */
  tier: string;
  /** The chosen effort, `""` for the agent default. */
  value: string;
  onChange: (effort: string) => void;
  /** The dialog is open: fetch the agent's stored model. */
  enabled: boolean;
}) {
  const tiersQuery = useModelTiers();
  const { data: modelsCatalog } = useModelsCatalog();
  const agentId = agent?.id ?? "";
  const fetchesConfigs = enabled && agentId !== "";
  const configsQuery = useResolvedConfigs({ agentId }, { enabled: fetchesConfigs });
  const options = taskEffortOptions({
    harness: agent?.harnessProvider,
    tier,
    tiers: tiersQuery.data,
    agentModel: configsQuery.data?.find((c) => c.key === "MODEL_OVERRIDE")?.value,
    lastUsedModel: agent?.credStatus?.latestModel?.model,
    catalog: modelsCatalog?.providers,
  });

  // A level the new agent or tier cannot take must not ride along to the API.
  // While the model behind the answer still loads, a level seeded from a
  // template stays: the answer would only be a guess.
  const loading =
    (fetchesConfigs && configsQuery.isPending) || (tier !== "" && tiersQuery.isPending);
  const kept = loading ? value : effortAllowed(options, value);
  useEffect(() => {
    if (value && kept !== value) onChange(kept);
  }, [value, kept, onChange]);

  const unsupported = options.kind === "unsupported";
  return (
    <div className="space-y-2">
      <Label>Reasoning Effort</Label>
      <Select
        value={kept}
        disabled={unsupported}
        onValueChange={(v) => onChange(v === "_none" ? "" : v)}
      >
        <SelectTrigger aria-label="Reasoning Effort">
          <SelectValue placeholder="Agent default" />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="_none">Agent default</SelectItem>
          {options.kind === "levels"
            ? options.levels.map((level) => (
                <SelectItem key={level} value={level}>
                  {level}
                </SelectItem>
              ))
            : null}
        </SelectContent>
      </Select>
      {options.kind === "unsupported" ? (
        <p className="text-xs text-muted-foreground">{options.reason}</p>
      ) : null}
    </div>
  );
}
