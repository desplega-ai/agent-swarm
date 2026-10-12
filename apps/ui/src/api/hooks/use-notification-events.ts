/**
 * Notification-center events.
 *
 * Two kinds of call, kept SEPARATE on purpose:
 *
 *   - `trackEvent` sends `notification.viewed` / `.dismissed` / `.submitted`
 *     as real telemetry events through the API (`useUiTelemetry`). The
 *     "submitted" event carries the email DOMAIN only, never the address.
 *     It honours the server's effective `ANONYMIZED_TELEMETRY` flag
 *     (`/status` → `telemetry.enabled`) and sends nothing while it is off.
 *   - `notifyUs` fires only when the user types an email and submits it
 *     (e.g. to open a Slack Connect channel). It goes to the feedback proxy
 *     (`/v1/feedback`, overridable via the `feedback_endpoint` global config
 *     key) with the RAW address, because that is the whole point of the ask.
 *     It is an explicit user action, so it is NOT gated, but it carries
 *     `install_id` / `installed_at` only while telemetry is on. It sends no
 *     telemetry: the proxy keeps the lead in feedback_submissions, and the
 *     API refuses `lead.captured` from the dashboard because it cannot
 *     verify the submission.
 */
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import { isUiTelemetryEnabled, sendUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import { useStatusContext } from "@/app/status-context";
import { useCurrentUser } from "@/contexts/current-user-context";

const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";
const FEEDBACK_ENDPOINT_CONFIG_KEY = "feedback_endpoint";

export type NotificationEventAction = "view" | "submit" | "dismiss";

/** Kept for callers that predate `isUiTelemetryEnabled`; same rule. */
export const isEventTrackingEnabled = isUiTelemetryEnabled;

export function useNotificationEvents() {
  const status = useStatusContext();
  const currentUser = useCurrentUser();
  const { data: globalConfigs } = useConfigs({ scope: "global" });
  const configValue = (key: string) =>
    globalConfigs?.find((entry) => entry.key === key)?.value.trim() || null;
  const feedbackEndpoint = configValue(FEEDBACK_ENDPOINT_CONFIG_KEY) ?? DEFAULT_FEEDBACK_ENDPOINT;
  const installId = configValue("telemetry_installation_id");
  const installedAt = configValue("telemetry_installed_at");
  const orgName = status.data?.identity.name ?? "";
  const submitFeedback = useSubmitFeedback(feedbackEndpoint);

  function trackEvent(
    notificationKey: string,
    action: NotificationEventAction,
    emailDomain?: string,
  ) {
    if (!currentUser.userId) return;
    const key = notificationKey;
    if (action === "view") {
      sendUiTelemetry(status.data, { event: "notification.viewed", properties: { key } });
    } else if (action === "dismiss") {
      sendUiTelemetry(status.data, { event: "notification.dismissed", properties: { key } });
    } else {
      sendUiTelemetry(status.data, {
        event: "notification.submitted",
        properties: { key, email_domain: emailDomain },
      });
    }
  }

  function notifyUs(notificationKey: string, note: string, email: string) {
    if (!currentUser.userId) return;
    submitFeedback.mutate({
      submission_id: crypto.randomUUID(),
      user_id: currentUser.userId,
      // The install id is telemetry identity: with telemetry off, leave it out.
      ...(isUiTelemetryEnabled(status.data) && installId
        ? { install_id: installId, installed_at: installedAt }
        : {}),
      org_name: orgName,
      swarm_version: __APP_VERSION__,
      email,
      newsletter_consent: false,
      message: `[notification] key=${notificationKey} ${note}`,
      submitted_at: new Date().toISOString(),
    });
  }

  return { trackEvent, notifyUs };
}
