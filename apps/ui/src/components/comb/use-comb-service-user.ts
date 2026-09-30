import { useStatusContext } from "@/app/status-context";

/**
 * agent-fs user id of the swarm service account (`/status`
 * `agent_fs.comb.service_user_id`). It writes the "[comb:sent ...]" replies,
 * so the marker rules in `lib/comb/markers.ts` trust only its replies. Null
 * when the API does not report it: the rules then accept any author except
 * the thread's own.
 */
export function useCombServiceUserId(): string | null {
  return useStatusContext().data?.agent_fs?.comb?.service_user_id ?? null;
}
