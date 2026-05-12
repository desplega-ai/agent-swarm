/**
 * Sessions surface (Phase 4 ≥1.76.0) — `/sessions` route.
 *
 * Shows the shared <SessionsShell> with a "New session" view in the right
 * pane: header strip + empty timeline + composer that creates a root task
 * and navigates to `/sessions/{newId}`. Same layout as the session detail
 * page so the chrome stays consistent.
 */

import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { NewSessionView } from "@/components/sessions/new-session-view";
import { SessionsShell } from "@/components/sessions/sessions-shell";

export default function SessionsPage() {
  const gate = useFeatureGate("1.76.0");

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
    <SessionsShell>
      <NewSessionView />
    </SessionsShell>
  );
}
