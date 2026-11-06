import { PageHeader } from "@/components/ui/page-header";
import { useIsMobile } from "@/hooks/use-mobile";
import { SwarmConfigSection } from "@/pages/config/components/swarm-config-section";
import { SecretsMobileList } from "./secrets-mobile-list";

/**
 * Secrets settings page — swarm-wide config values stored server-side.
 */
export default function SecretsPage() {
  // mockup(ui-audit): phone gets a MobileList with full keys + scope line instead of the compact grid
  const isMobile = useIsMobile();
  return (
    <div className="flex flex-col flex-1 min-h-0 gap-6">
      <PageHeader title="Secrets" />
      {isMobile ? <SecretsMobileList /> : <SwarmConfigSection />}
    </div>
  );
}
