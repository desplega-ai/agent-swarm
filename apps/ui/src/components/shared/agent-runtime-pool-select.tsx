import { toast } from "sonner";
import { useBindAgentRuntimePool, useRuntimePools } from "@/api/hooks/use-runtime-pools";
import type { Agent } from "@/api/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deliveryLabel, RUNTIME_KIND_LABEL, RUNTIME_LIFECYCLE_LABEL } from "@/lib/runtime-pools";

const NO_POOL = "none";

/**
 * "Runtime pool" picker for one agent. A pick applies at once through
 * `PUT /api/agents/{id}/runtime-pool`: it is one field with its own route, not
 * part of the runtime form's Save (`AgentRuntimeSettings`). Render it only
 * while `useRuntimePoolsGate()` is open.
 */
export function AgentRuntimePoolSelect({ agent }: { agent: Agent }) {
  const pools = useRuntimePools();
  const bind = useBindAgentRuntimePool();
  const current = (pools.data ?? []).find((pool) => pool.id === agent.runtimePoolId) ?? null;

  function change(value: string) {
    const poolId = value === NO_POOL ? null : value;
    if (poolId === (agent.runtimePoolId ?? null)) return;
    bind.mutate(
      { agentId: agent.id, poolId },
      {
        onSuccess: () => toast.success(poolId ? "Runtime pool updated" : "Unbound from pool"),
        onError: (err) => toast.error(err.message),
      },
    );
  }

  return (
    <div className="space-y-1.5">
      <Select
        value={agent.runtimePoolId ?? NO_POOL}
        onValueChange={change}
        disabled={bind.isPending || pools.isLoading}
      >
        <SelectTrigger className="w-full sm:w-72" aria-label="Runtime pool">
          <SelectValue placeholder={pools.isLoading ? "Loading..." : "No pool"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NO_POOL}>No pool</SelectItem>
          {(pools.data ?? []).map((pool) => (
            <SelectItem key={pool.id} value={pool.id} disabled={!pool.enabled}>
              {pool.name}
              {pool.enabled ? "" : " (disabled)"}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-xs text-muted-foreground">
        {current
          ? `${RUNTIME_KIND_LABEL[current.kind]} · ${RUNTIME_LIFECYCLE_LABEL[current.lifecycle]} · ${deliveryLabel(current.delivery)} delivery`
          : pools.error
            ? `Pools are unavailable: ${pools.error.message}`
            : "The agent runs wherever its worker was started."}
      </p>
    </div>
  );
}
