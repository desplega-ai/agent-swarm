/**
 * The monthly fleet benchmark report (the fleet benchmark card, `full` level).
 *
 * Subscribing is an explicit, opt-in request: it sends the typed email with a
 * `[fleet_report]` message to the feedback proxy (`useSubmitFeedback`), like
 * the Slack Connect invite. It sends no telemetry: the API refuses `lead.captured`
 * from the dashboard, because it cannot verify a browser-sent submission.
 */
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import { useStatusContext } from "@/app/status-context";
import { useCurrentUser } from "@/contexts/current-user-context";

export function useSubscribeFleetReport() {
  const status = useStatusContext();
  const { userId } = useCurrentUser();
  const submit = useSubmitFeedback();

  return async function subscribe(email: string): Promise<void> {
    if (!userId) throw new Error("Pick a user first.");
    await submit.mutateAsync({
      submission_id: crypto.randomUUID(),
      user_id: userId,
      org_name: status.data?.identity.name ?? "",
      swarm_version: __APP_VERSION__,
      email: email.trim(),
      newsletter_consent: false,
      message: "[fleet_report] subscribed to the monthly fleet benchmark report",
      submitted_at: new Date().toISOString(),
    });
  };
}
