/**
 * Sessions surface (Phase 4 ≥1.76.0): `/sessions` and `/sessions/:rootTaskId`.
 *
 * The router sends both paths here, so the sessions v2 shell stays mounted
 * when the focused session changes. After "Legacy sessions" (see
 * `useSessionsView`) it renders the legacy pages unchanged: on `/sessions`
 * the shared <SessionsShell> with a "New session" view in the right pane
 * (header strip + empty timeline + a composer that creates a root task and
 * navigates to `/sessions/{newId}`), and on `/sessions/:rootTaskId` the
 * legacy detail page.
 */

import { useParams } from "react-router-dom";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { UpgradeRequired } from "@/components/feature-gate/upgrade-required";
import { NewSessionView } from "@/components/sessions/new-session-view";
import { SessionsShell } from "@/components/sessions/sessions-shell";
import { SessionsV2Shell } from "@/components/sessions-v2/sessions-v2-shell";
import { PageSkeleton } from "@/components/shared/page-skeleton";
import { useSessionsView, useSessionsViewCommand } from "@/hooks/use-sessions-view";
import { NEW_SESSION_TAB } from "@/lib/sessions-v2";
import SessionDetailPage from "./[rootTaskId]/page";

export default function SessionsPage() {
  const { rootTaskId: routeId } = useParams<{ rootTaskId: string }>();
  // The v2 view puts a New session tab on `/sessions/new` while a group tab is open.
  const rootTaskId = routeId === NEW_SESSION_TAB ? undefined : routeId;
  const gate = useFeatureGate("1.76.0");
  const sessionsView = useSessionsView();
  useSessionsViewCommand(sessionsView);

  if (sessionsView.pending) return <PageSkeleton />;
  if (sessionsView.view === "v2") return <SessionsV2Shell onViewChange={sessionsView.setView} />;

  const onNewView = sessionsView.supported ? () => sessionsView.setView("v2") : undefined;
  if (rootTaskId) return <SessionDetailPage onNewView={onNewView} />;

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
    <SessionsShell onNewView={onNewView}>
      <NewSessionView />
    </SessionsShell>
  );
}
