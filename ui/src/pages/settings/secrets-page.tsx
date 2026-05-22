import { PageHeader } from "@/components/ui/page-header";
import { SwarmConfigSection } from "@/pages/config/components/swarm-config-section";

/**
 * Secrets settings page — swarm-wide config values stored server-side.
 */
export default function SecretsPage() {
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader title="Secrets" />
      <SwarmConfigSection />
    </div>
  );
}
