import { useMemo } from "react";
import { useApprovalRequestSummaries } from "@/api/hooks/use-approval-requests";
import { useCredentialMissingAgents } from "@/api/hooks/use-credential-missing-agents";
import { useFeatureGate } from "@/api/hooks/use-feature-gate";
import { useSessions } from "@/api/hooks/use-sessions";
import { needsYouCount, needsYouItems } from "@/lib/needs-you";
import { SESSIONS_V2_MIN_VERSION } from "@/lib/sessions-v2";

/** Sessions that need you, one page. Past it the count stops growing. */
const NEEDS_SESSIONS_LIMIT = 50;

/**
 * The reads behind "Needs you" (Home) and the Home badge (sidebar): pending
 * approvals, sessions that need the viewer, and agents blocked on
 * credentials. Both callers share the same react-query caches, so the badge
 * and the widget's pill always agree.
 */
export function useNeedsYou(options?: { enabled?: boolean }) {
  const enabled = options?.enabled ?? true;
  // `status=needs` is a sessions v2 filter: an older server ignores it and
  // would answer with every session.
  const sessionsV2 = useFeatureGate(SESSIONS_V2_MIN_VERSION).supported;
  const approvals = useApprovalRequestSummaries({ status: "pending" }, { enabled });
  const sessions = useSessions({
    status: "needs",
    scope: "tree",
    limit: NEEDS_SESSIONS_LIMIT,
    enabled: enabled && sessionsV2,
  });
  const credentials = useCredentialMissingAgents({ enabled });

  const items = useMemo(
    () =>
      needsYouItems({
        approvals: approvals.data,
        sessions: sessions.data?.sessions,
        credentials: credentials.data,
      }),
    [approvals.data, sessions.data, credentials.data],
  );

  return { items, count: needsYouCount(items), approvals, sessions, credentials };
}
