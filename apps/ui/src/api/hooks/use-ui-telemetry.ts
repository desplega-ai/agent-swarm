/**
 * Dashboard telemetry events (`popup.*`, `notification.*`, `org.*`, `identity.*`,
 * `fleet_benchmark.*`, `setup.*`).
 *
 * The browser never talks to the telemetry proxy. It posts each event to
 * `POST /api/telemetry/ui-event`, and the API sends it with the normal v2
 * envelope (install, org, version). The API checks the name and properties
 * against the event catalog and drops everything while telemetry is off.
 *
 * The hook gates on the browser side too: nothing leaves while `/status` is
 * loading or reports `telemetry.enabled === false`. A dropped analytics event
 * costs less than a leaked one.
 */
import { useCallback } from "react";
import { api } from "@/api/client";
import type { ProviderName, SlackConnectMoment, StatusResponse } from "@/api/types";
import { useStatusContext } from "@/app/status-context";
import type { UserFunction } from "@/lib/company-profile";

export type PopupName = "feedback" | "org_name" | "used_by";
export type PopupTrigger =
  | "task_failed"
  | "tasks_completed"
  | "workflow_completed"
  | "quarterly"
  | "missing_org_name";
export type PopupDismissMethod = "later" | "close" | "escape";
export type OrgProfileField = "name" | "website" | "team_size" | "use_case" | "acquisition_source";
export type OrgProfileSurface =
  | "prompt"
  | "setup"
  | "settings"
  | "org_name_popup"
  | "feedback"
  | "fleet_benchmark"
  | "telemetry_banner"
  | "identity_modal";

/** The catalogued events the dashboard sends, with their properties. */
export type UiTelemetryEvent =
  | { event: "popup.shown"; properties: { popup: PopupName; trigger: PopupTrigger } }
  | { event: "popup.dismissed"; properties: { popup: PopupName; method: PopupDismissMethod } }
  | {
      event: "popup.submitted";
      properties: {
        popup: PopupName;
        score?: number;
        has_message: boolean;
        has_contact: boolean;
        /** How many follow-up questions were answered. */
        answered?: number;
        perks?: Array<"used_by" | "slack_connect">;
      };
    }
  | { event: "notification.viewed"; properties: { key: string; moment?: SlackConnectMoment } }
  | { event: "notification.dismissed"; properties: { key: string; moment?: SlackConnectMoment } }
  | {
      event: "notification.submitted";
      properties: {
        key: string;
        email_domain?: string;
        moment?: SlackConnectMoment;
        user_function?: UserFunction;
      };
    }
  | {
      event: "org.profile_updated";
      properties: { fields: OrgProfileField[]; surface: OrgProfileSurface };
    }
  | {
      event: "fleet_benchmark.viewed";
      properties: { has_org_name: boolean; level?: "basic" | "full" };
    }
  | {
      event: "fleet_benchmark.unlocked";
      properties: { fields: Array<"website" | "team_size" | "use_case"> };
    }
  | { event: "identity.lookup"; properties: { matched: boolean } }
  | {
      event: "identity.user_created";
      properties: {
        surface: "identity_modal" | "setup";
        email_kind: "work" | "personal";
        has_function: boolean;
        has_company: boolean;
      };
    }
  | {
      event: "setup.worker_command_copied";
      properties: { target: "compose" | "docker" | "kubernetes"; harness: ProviderName };
    }
  | { event: "feature.used"; properties: { feature: string } };

/**
 * Whether dashboard events may leave the browser.
 *
 * - `undefined` (`/status` not resolved yet): no.
 * - `null` (older API without `/status`) or a payload without `telemetry`:
 *   yes, matching the server default (on unless `ANONYMIZED_TELEMETRY=false`).
 */
export function isUiTelemetryEnabled(status: StatusResponse | null | undefined): boolean {
  if (status === undefined) return false;
  return status?.telemetry?.enabled !== false;
}

/** Send one dashboard event. Fire-and-forget: failures are swallowed. */
export function sendUiTelemetry(
  status: StatusResponse | null | undefined,
  input: UiTelemetryEvent,
): void {
  if (!isUiTelemetryEnabled(status)) return;
  // Drop undefined optional properties: the catalog check rejects nothing for
  // them, but the wire stays tidy.
  const properties = Object.fromEntries(
    Object.entries(input.properties).filter(([, value]) => value !== undefined),
  );
  api.sendUiEvent(input.event, properties).catch(() => {});
}

export function useUiTelemetry(): (input: UiTelemetryEvent) => void {
  const status = useStatusContext();
  const data = status.data;
  return useCallback((input: UiTelemetryEvent) => sendUiTelemetry(data, input), [data]);
}
