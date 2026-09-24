import { useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { api } from "@/api/client";
import { ONBOARDING_QUERY_KEY } from "@/api/hooks/use-onboarding";
import type { AgentWithTasks, ProviderName } from "@/api/types";
import { SetupChip } from "@/components/onboarding/setup-card";
import { BrandLogo } from "@/components/shared/brand-logo";
import { HarnessIcon } from "@/components/shared/harness-icon";
import { StatusLine } from "@/components/shared/status-icon";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { HARNESS_LABEL } from "@/lib/agent-runtime-models";

/** `HarnessIcon` has no dsh mark; the DeepSeek logo stands in. */
export function AiHarnessIcon({ harness }: { harness: string | null | undefined }) {
  if (harness === "dsh") {
    return <BrandLogo src="/provider-logos/deepseek.svg" className="size-3.5" />;
  }
  return <HarnessIcon harness={harness} />;
}

/**
 * R2: the rollup keys on the worker harness, so a key verifies only when some
 * worker runs the card's harness. Offer a per-agent switch (never global).
 */
export function HarnessSwitch({
  harnessPhrase,
  targets,
  agents,
  onSwitched,
}: {
  /** "Codex", or "Pi-Mono, Opencode, or DeepSeek (dsh)" for the open harnesses card. */
  harnessPhrase: string;
  /** Harnesses the user can switch to. More than one renders a picker. */
  targets: readonly ProviderName[];
  agents: AgentWithTasks[];
  /** The agents whose switch succeeded (their model level carries over). */
  onSwitched: (agentIds: string[]) => void;
}) {
  const queryClient = useQueryClient();
  const [target, setTarget] = useState<ProviderName>(targets[0]);
  const [checked, setChecked] = useState<ReadonlySet<string>>(() => new Set());
  const [busy, setBusy] = useState(false);

  const count = checked.size;
  const targetName = HARNESS_LABEL[target] ?? target;

  function toggle(id: string) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function switchAgents() {
    setBusy(true);
    const ids = [...checked];
    const results = await Promise.allSettled(
      ids.map((id) => api.setAgentHarnessProvider(id, target)),
    );
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    const switched = ids.length - failures.length;
    onSwitched(ids.filter((_, index) => results[index].status === "fulfilled"));
    if (failures.length === 0) {
      toast.success(
        `Switched ${switched} agent${switched === 1 ? "" : "s"} to ${targetName}. They pick it up within about 10 seconds.`,
      );
    } else {
      const first = failures[0].reason instanceof Error ? failures[0].reason.message : "";
      toast.error(`Switched ${switched} of ${ids.length} agents. ${first}`.trim());
    }
    setChecked(new Set());
    setBusy(false);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["agents"] }),
      queryClient.invalidateQueries({ queryKey: ONBOARDING_QUERY_KEY }),
    ]);
  }

  return (
    <div className="space-y-2">
      <StatusLine tone="warning">
        No worker runs {harnessPhrase} yet. Switch some to use this key.
      </StatusLine>
      <ul className="max-h-48 divide-y divide-border-subtle overflow-y-auto rounded-lg border border-border">
        {agents.map((agent) => (
          <li key={agent.id}>
            <label className="flex items-center gap-2.5 px-3 py-2 text-sm hover:bg-accent/50 hover-linger transition-colors">
              <input
                type="checkbox"
                checked={checked.has(agent.id)}
                onChange={() => toggle(agent.id)}
                className="size-4 shrink-0 rounded border-input accent-primary"
              />
              <span className="min-w-0 truncate font-medium">{agent.name}</span>
              <SetupChip>{agent.isLead ? "Lead" : "Worker"}</SetupChip>
              <span className="ml-auto flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                <AiHarnessIcon harness={agent.harnessProvider} />
                {agent.harnessProvider
                  ? (HARNESS_LABEL[agent.harnessProvider] ?? agent.harnessProvider)
                  : "unknown"}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center gap-2">
        {targets.length > 1 ? (
          <Select value={target} onValueChange={(v) => setTarget(v as ProviderName)}>
            <SelectTrigger className="w-44" aria-label="Target harness">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {targets.map((h) => (
                <SelectItem key={h} value={h}>
                  <AiHarnessIcon harness={h} />
                  {HARNESS_LABEL[h] ?? h}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        <Button
          type="button"
          variant="outline"
          disabled={count === 0 || busy}
          onClick={switchAgents}
        >
          {busy ? <Loader2 className="animate-spin" /> : null}
          Switch {count} agent{count === 1 ? "" : "s"} to {targetName}
        </Button>
      </div>
    </div>
  );
}
