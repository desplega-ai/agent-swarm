/**
 * Notification-center event tracking.
 *
 * There is no PostHog (or similar) in this dashboard — the only outbound
 * channel to us is the existing feedback proxy (`useSubmitFeedback`, already
 * live at `https://proxy.desplega.sh/v1/feedback`, overridable via the
 * `feedback_endpoint` global config key). We reuse it for two distinct kinds
 * of call, kept SEPARATE on purpose:
 *
 *   - `trackEvent` — fired for every view/dismiss/submit/already-have-one
 *     interaction. Carries the install id and, for the "submit" action, the
 *     requester's email DOMAIN only (never the address).
 *   - `notifyUs` — fired only when the user submits an email (e.g. to open a
 *     Slack Connect channel). Carries the RAW address, because that's the
 *     whole point of the ask — but only this call ever sees it.
 *
 * Both piggyback on `FeedbackInput.message` as a small structured string
 * since the feedback schema has no dedicated "event" field; if `/v1/feedback`
 * grows one, switch these to it instead of the message convention.
 *
 * Opt-out: `trackEvent` is background analytics, so it honours the server's
 * effective `ANONYMIZED_TELEMETRY` flag (`/status` → `telemetry.enabled`) and
 * sends nothing when the operator turned telemetry off. `notifyUs` is NOT
 * gated: it only fires when the user types their email and submits it.
 */
import { useConfigs } from "@/api/hooks/use-config-api";
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import type { StatusResponse } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { useCurrentUser } from "@/contexts/current-user-context";

const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";
const FEEDBACK_ENDPOINT_CONFIG_KEY = "feedback_endpoint";

export type NotificationEventAction = "view" | "submit" | "dismiss" | "already_have_one";

/**
 * Whether background notification events may leave the browser.
 *
 * - `undefined` (`/status` not resolved yet): no. We can't know the opt-out
 *   yet, and a dropped analytics event costs less than a leaked one.
 * - `null` (older API without `/status`) or a payload without `telemetry`:
 *   yes, matching the server default (on unless `ANONYMIZED_TELEMETRY=false`).
 */
export function isEventTrackingEnabled(status: StatusResponse | null | undefined): boolean {
  if (status === undefined) return false;
  return status?.telemetry?.enabled !== false;
}

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
    if (!isEventTrackingEnabled(status.data)) return;
    submitFeedback.mutate({
      submission_id: crypto.randomUUID(),
      user_id: currentUser.userId,
      install_id: installId,
      installed_at: installedAt,
      org_name: orgName,
      swarm_version: __APP_VERSION__,
      newsletter_consent: false,
      message: `[notification_event] key=${notificationKey} action=${action}${
        emailDomain ? ` domain=${emailDomain}` : ""
      }`,
      submitted_at: new Date().toISOString(),
    });
  }

  function notifyUs(notificationKey: string, note: string, email: string) {
    if (!currentUser.userId) return;
    submitFeedback.mutate({
      submission_id: crypto.randomUUID(),
      user_id: currentUser.userId,
      install_id: installId,
      installed_at: installedAt,
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
