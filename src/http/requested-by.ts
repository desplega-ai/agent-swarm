import { z } from "zod";
import { getUserById } from "../be/db";
import { renderIdentity, resolveIdentity } from "../be/identity";
import { UserCommsPrefsSchema, UserSchema } from "../types";
import { getUserCommsPrefs } from "../utils/requester-comms";

// Requester projection sent with a task to the worker that runs it (poll
// triggers, paused-task resume) — either the resolved user's identity fields,
// or (when no `requestedByUserId` is recorded) just a rendered `name` for the
// UNKNOWN-identity sentinel.
export const TaskRequestedBySchema = UserSchema.pick({
  id: true,
  name: true,
  email: true,
  role: true,
  notes: true,
}).extend({
  // Absent for the UNKNOWN-identity sentinel (Slack-only requester, no users row).
  id: z.string().optional(),
  // Structured communication preferences from `users.metadata.comms`.
  comms: UserCommsPrefsSchema.optional(),
});

function getRequesterNotes(notes: string | undefined): string | undefined {
  return typeof notes === "string" && notes.trim().length > 0 ? notes : undefined;
}

/**
 * Resolve the requester projection for a task. If the task carries a
 * machine-recorded external id (today: the Slack user field) but no
 * requestedByUserId, render the explicit UNKNOWN sentinel instead of silently
 * omitting the section: never a substituted human (Rule 33 /
 * provenance-or-silence).
 */
export async function buildTaskRequestedBy(task: {
  requestedByUserId?: string | null;
  slackUserId?: string | null;
}): Promise<z.infer<typeof TaskRequestedBySchema> | undefined> {
  const user = task.requestedByUserId ? await getUserById(task.requestedByUserId) : undefined;
  if (user) {
    return {
      id: user.id,
      name: user.name,
      email: user.email,
      role: user.role,
      notes: getRequesterNotes(user.notes),
      comms: getUserCommsPrefs(user),
    };
  }
  if (task.slackUserId) {
    return { name: renderIdentity(await resolveIdentity("slack", task.slackUserId)) };
  }
  return undefined;
}
