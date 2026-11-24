import type { EventTriggerMatch, TriggerConfig, Workflow } from "../types";

type EventTrigger = Extract<TriggerConfig, { type: "event" }>;

const norm = (value: string): string => value.trim().toLowerCase();

function strings(...values: unknown[]): string[] {
  return values.flat().filter((value): value is string => typeof value === "string" && !!value);
}

/**
 * Payload values one match field compares against. On an event that names the
 * label or assignee it added (`label`, `assigned_to`), only that one counts, so
 * `issue.labeled` with `label: "bug"` starts on the delivery that added `bug`.
 */
function candidates(field: keyof EventTriggerMatch, payload: Record<string, unknown>): string[] {
  switch (field) {
    case "repo":
      return strings(payload.repo);
    case "project":
      return strings(payload.project);
    case "status":
      return strings(payload.status);
    case "label":
      return "label" in payload ? strings(payload.label) : strings(payload.labels);
    case "assignee":
      return "assigned_to" in payload
        ? strings(payload.assigned_to, payload.assigned_to_account_id)
        : strings(payload.assignees, payload.assignee, payload.assignee_account_id);
  }
}

/**
 * True when one `event` trigger starts on this payload. A `github.*` trigger
 * also requires the payload `action` to equal the name's last segment: the bus
 * name `github.issue_comment.created` carries every comment action, which
 * `wait` nodes rely on.
 */
export function eventTriggerMatches(
  trigger: EventTrigger,
  eventName: string,
  payload: unknown,
): boolean {
  if (trigger.eventName !== eventName) return false;
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {};
  if (eventName.startsWith("github.") && record.action !== eventName.split(".").pop()) {
    return false;
  }
  for (const [field, expected] of Object.entries(trigger.match ?? {})) {
    if (typeof expected !== "string") continue;
    const want = norm(expected);
    const got = candidates(field as keyof EventTriggerMatch, record);
    if (!got.some((value) => norm(value) === want)) return false;
  }
  return true;
}

/** True when any of the workflow's `event` triggers for `eventName` starts on this payload. */
export function workflowEventTriggerMatches(
  workflow: Workflow,
  eventName: string,
  payload: unknown,
): boolean {
  return (workflow.triggers ?? []).some(
    (trigger) => trigger.type === "event" && eventTriggerMatches(trigger, eventName, payload),
  );
}
