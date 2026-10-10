import { useOnboarding } from "@/api/hooks/use-onboarding";
import { EmbeddingsSetup } from "@/pages/setup/steps/step-memory";

/** The settings page has no Continue to hold while a probe runs. */
function noContinueBlocker() {}

/**
 * Memory integration: the `/setup` embeddings form, with the same presets and
 * the same test-and-save probe (`POST /api/onboarding/memory`). The generic
 * fields, collapsed under Advanced, edit the stored values by hand.
 */
export function MemoryEmbeddingsSection() {
  const { data } = useOnboarding();
  // Without the onboarding API (an older server) only the Advanced fields show.
  if (!data) return null;
  const { configured, dimensions } = data.signals.embeddings;
  return (
    <EmbeddingsSetup
      configured={configured}
      dimensions={dimensions}
      setContinueBlocker={noContinueBlocker}
    />
  );
}
