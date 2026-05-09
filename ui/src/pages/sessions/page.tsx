/**
 * Sessions surface (Phase 4 ≥1.76.0) — `/sessions` route.
 *
 * Sidebar list + centered empty pane on the right ("pick a session"). The
 * actual chain detail lives at `/sessions/:rootTaskId` (separate route);
 * picking a sidebar entry navigates there.
 */

import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSessions } from "@/api/hooks/use-sessions";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { SessionsEmptyPane, SessionsShell } from "@/components/sessions/sessions-shell";

export default function SessionsPage() {
  const gate = useFeatureGate("1.76.0");
  const { data: sessions, isLoading } = useSessions({ limit: 50 });

  if (!gate.supported) {
    return (
      <UpgradeRequired
        feature="Sessions"
        requiredVersion={gate.requiredVersion}
        currentVersion={gate.currentVersion}
      />
    );
  }

  return (
    <SessionsShell sessions={sessions} isLoading={isLoading}>
      <SessionsEmptyPane />
    </SessionsShell>
  );
}
