/**
 * Notification-center events.
 *
 * Two kinds of call, kept SEPARATE on purpose:
 *
 *   - `trackEvent` sends `notification.viewed` / `.dismissed` / `.submitted`
 *     as real telemetry events through the API (`useUiTelemetry`), with the
 *     Slack Connect `moment` when the card has one. The "submitted" event
 *     carries the email DOMAIN only, never the address.
 *     It honours the server's effective `ANONYMIZED_TELEMETRY` flag
 *     (`/status` → `telemetry.enabled`) and sends nothing while it is off.
 *   - `notifyUs` fires only when the user types an email and submits it
 *     (e.g. to open a Slack Connect channel). It goes to the feedback proxy
 *     (`useSubmitFeedback`) with the RAW address, because that is the whole
 *     point of the ask. It is an explicit user action, so it is NOT gated,
 *     but `useSubmitFeedback` adds `install_id` / `installed_at` only while
 *     telemetry is on. It sends no telemetry: the proxy keeps the lead in
 *     feedback_submissions, and the API refuses `lead.captured` from the
 *     dashboard because it cannot verify the submission.
 */
import { useSubmitFeedback } from "@/api/hooks/use-feedback";
import { isUiTelemetryEnabled, sendUiTelemetry } from "@/api/hooks/use-ui-telemetry";
import type { FeedbackInput, SlackConnectMoment } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import { useCurrentUser } from "@/contexts/current-user-context";
import type { UserFunction } from "@/lib/company-profile";
import { reportedUserFunction } from "../../../../../src/utils/company-profile";

export type NotificationEventAction = "view" | "submit" | "dismiss";

/** Extra `notification.submitted` properties. View and dismiss send only `moment`. */
export interface NotificationEventProperties {
  /** The email DOMAIN only, never the address. */
  email_domain?: string;
  moment?: SlackConnectMoment;
  user_function?: UserFunction;
}

export type NotifyUsExtra = Partial<
  Pick<
    FeedbackInput,
    "submission_id" | "moment" | "user_function" | "team_size" | "working_on" | "org_name"
  >
>;

/** Kept for callers that predate `isUiTelemetryEnabled`; same rule. */
export const isEventTrackingEnabled = isUiTelemetryEnabled;

export function useNotificationEvents() {
  const status = useStatusContext();
  const currentUser = useCurrentUser();
  const orgName = status.data?.identity.name ?? "";
  const submitFeedback = useSubmitFeedback();

  function trackEvent(
    notificationKey: string,
    action: NotificationEventAction,
    properties: NotificationEventProperties = {},
  ) {
    if (!currentUser.userId) return;
    const key = notificationKey;
    const { moment } = properties;
    if (action === "view") {
      sendUiTelemetry(status.data, { event: "notification.viewed", properties: { key, moment } });
    } else if (action === "dismiss") {
      sendUiTelemetry(status.data, {
        event: "notification.dismissed",
        properties: { key, moment },
      });
    } else {
      sendUiTelemetry(status.data, {
        event: "notification.submitted",
        // The catalog rejects a job function it does not list yet: leave it out.
        properties: {
          key,
          ...properties,
          user_function: reportedUserFunction(properties.user_function),
        },
      });
    }
  }

  /**
   * `extra` adds profile answers, or a `submission_id` that updates an earlier
   * request. Resolves once the proxy accepts it.
   */
  function notifyUs(
    notificationKey: string,
    note: string,
    email: string,
    extra: NotifyUsExtra = {},
  ): Promise<void> {
    if (!currentUser.userId) return Promise.reject(new Error("Pick who you are first."));
    return submitFeedback.mutateAsync({
      submission_id: crypto.randomUUID(),
      ...extra,
      user_id: currentUser.userId,
      // The caller may pass a name newer than the last /status poll (the org-name popup).
      org_name: extra.org_name ?? orgName,
      swarm_version: __APP_VERSION__,
      email,
      newsletter_consent: false,
      message: `[notification] key=${notificationKey} ${note}`,
      submitted_at: new Date().toISOString(),
    });
  }

  return { trackEvent, notifyUs };
}
