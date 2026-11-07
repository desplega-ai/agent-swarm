import { useMemo } from "react";
import { useAgents } from "@/api/hooks/use-agents";
import { PageHeader } from "@/components/ui/page-header";
import { PlaygroundPanel } from "@/pages/connections/playground-panel";

/** Settings › Advanced › Playground: try script connections as an agent. */
export default function ConnectionPlaygroundPage() {
  const { data: agents } = useAgents(false);
  const defaultAgentId = useMemo(
    () => agents?.find((agent) => agent.isLead)?.id ?? agents?.[0]?.id,
    [agents],
  );
  return (
    <div className="flex flex-col gap-4">
      <PageHeader title="Playground" />
      <PlaygroundPanel defaultAgentId={defaultAgentId} />
    </div>
  );
}
