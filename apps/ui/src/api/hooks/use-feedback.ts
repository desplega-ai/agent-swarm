import { useMutation } from "@tanstack/react-query";
import { useConfigs } from "@/api/hooks/use-config-api";
import { isUiTelemetryEnabled } from "@/api/hooks/use-ui-telemetry";
import { useStatusContext } from "@/app/status-context";
import { api } from "../client";
import type { FeedbackInput } from "../types";

const DEFAULT_FEEDBACK_ENDPOINT = "https://proxy.desplega.sh/v1/feedback";

/**
 * Posts a submission from the browser to the feedback proxy: the
 * `feedback_endpoint` global config key, else Desplega's proxy. Every
 * dashboard submission goes through here (feedback popup, Slack Connect
 * invite, setup help, fleet report). The hook adds the install identity
 * (`install_id`, `installed_at`) only while telemetry is on: it is telemetry
 * identity, so with telemetry off it stays out.
 */
export function useSubmitFeedback() {
  const status = useStatusContext();
  const { data: configs } = useConfigs({ scope: "global" });
  const value = (key: string) => configs?.find((entry) => entry.key === key)?.value.trim() || null;
  const endpoint = value("feedback_endpoint") ?? DEFAULT_FEEDBACK_ENDPOINT;
  const installId = value("telemetry_installation_id");
  const install =
    isUiTelemetryEnabled(status.data) && installId
      ? { install_id: installId, installed_at: value("telemetry_installed_at") }
      : {};
  return useMutation({
    mutationFn: (input: FeedbackInput) => api.submitFeedback(endpoint, { ...install, ...input }),
  });
}
