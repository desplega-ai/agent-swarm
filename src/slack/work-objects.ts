import type { App, SlackEventMiddlewareArgs } from "@slack/bolt";
import type { EntityPresentDetailsArguments, WebClient } from "@slack/web-api";
import { getAgentById, getTaskById } from "../be/db";
import { isEnvFlagEnabled } from "../utils/env-flag";
import { getTaskUrl } from "./blocks";
import { isUserAllowed } from "./handlers";

type DetailsEvent = SlackEventMiddlewareArgs<"entity_details_requested">["event"];
type Details = Omit<EntityPresentDetailsArguments, "trigger_id" | "token">;

function truncate(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit - 1)}…` : text;
}

async function getDetails(event: DetailsEvent, client: WebClient): Promise<Details> {
  const ref = event.external_ref;
  // external_ref.type is our resource type, not Slack's entity_type. Never fetch event URLs.
  if (ref?.type !== "task" || !ref.id) {
    return {
      error: {
        status: "custom",
        custom_title: "Work Object unavailable",
        custom_message: "Agent Swarm does not support this Work Object reference.",
      },
    };
  }

  if (!event.user || !event.channel || !(await isUserAllowed(client, event.user))) {
    return { error: { status: "restricted" } };
  }

  const task = await getTaskById(ref.id);
  if (!task) return { error: { status: "not_found" } };

  // A forwarded card must not expose a private task to another conversation.
  if (task.slackChannelId !== event.channel) return { error: { status: "restricted" } };

  const agent = task.agentId ? await getAgentById(task.agentId) : null;
  const result = task.output || task.failureReason || task.progress;
  return {
    metadata: {
      entity_type: "slack#/entities/task",
      external_ref: ref,
      url: getTaskUrl(task.id),
      entity_payload: {
        attributes: {
          title: { text: truncate(task.title?.trim() || task.task, 200) },
          display_id: task.id.slice(0, 8),
          display_type: "Task",
          product_name: "Agent Swarm",
          metadata_last_modified: Math.floor(Date.parse(task.lastUpdatedAt) / 1000),
        },
        fields: {
          description: { value: truncate(task.task, 2800), format: "markdown" },
          status: { value: task.status },
          assignee: { type: "string", value: agent?.name || task.agentId || "Unassigned" },
          priority: { value: String(task.priority) },
          date_created: { value: Math.floor(Date.parse(task.createdAt) / 1000) },
          date_updated: { value: Math.floor(Date.parse(task.lastUpdatedAt) / 1000) },
        },
        ...(result
          ? {
              custom_fields: [
                {
                  key: "result",
                  label: task.output ? "Result" : task.failureReason ? "Failure" : "Progress",
                  type: "string",
                  value: truncate(result, 2800),
                  format: "markdown",
                },
              ],
            }
          : {}),
        display_order: [
          "status",
          "assignee",
          "priority",
          "description",
          ...(result ? ["result"] : []),
          "date_created",
          "date_updated",
        ],
      },
    },
  };
}

export function registerWorkObjectHandlers(app: App): void {
  // Bolt acknowledges Events API deliveries; the flexpane needs a separate API response.
  app.event("entity_details_requested", async ({ event, client, logger }) => {
    if (!isEnvFlagEnabled("SLACK_WORK_OBJECTS_ENABLED", false)) return;

    let details: Details;
    try {
      details = await getDetails(event, client);
    } catch (error) {
      logger.error("[Slack] Failed to load Work Object details", error);
      details = { error: { status: "internal_error" } };
    }

    try {
      await client.entity.presentDetails({ trigger_id: event.trigger_id, ...details });
    } catch (error) {
      logger.error("[Slack] Failed to present Work Object details", error);
      // If Slack rejects the metadata, still try to replace the spinner with an error view.
      if (details.metadata) {
        try {
          await client.entity.presentDetails({
            trigger_id: event.trigger_id,
            error: { status: "internal_error" },
          });
        } catch (fallbackError) {
          logger.error("[Slack] Failed to present Work Object error", fallbackError);
        }
      }
    }
  });
}
