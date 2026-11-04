import { PageHeader } from "@/components/ui/page-header";
import { ScriptConnectionsPanel } from "@/pages/connections/page";

/** Settings › Advanced › Raw fetch credentials: bindings for raw `fetch()` calls in scripts. */
export default function FetchCredentialsPage() {
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-4">
      <PageHeader title="Raw fetch credentials" />
      <ScriptConnectionsPanel tab="bindings" />
    </div>
  );
}
