import { z } from "zod";
import { getUserById } from "../be/db";
import { renderIdentity, resolveIdentity } from "../be/identity";
import {
  SlackParticipantTrustSchema,
  type TaskSlackParticipants,
  UserCommsPrefsSchema,
  UserSchema,
} from "../types";
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

const isUntrusted = (trust: string) => trust === "external" || trust === "unknown";

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
  slackParticipants?: TaskSlackParticipants;
}): Promise<z.infer<typeof TaskRequestedBySchema> | undefined> {
  const user = task.requestedByUserId ? await getUserById(task.requestedByUserId) : undefined;
  if (user) {
    // An external or unknown trigger sender never gets a full profile.
    const newest = task.slackParticipants?.people.find((person) => person.newest);
    if (newest && isUntrusted(newest.trust)) {
      return { id: user.id, name: user.name, email: user.email };
    }
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

const MAX_NOTE_CHARS = 60;
const cut = (value: string | undefined) =>
  value?.trim() ? value.trim().slice(0, MAX_NOTE_CHARS) : undefined;

// Thread participants projection for a multi-person Slack thread, resolved at
// claim like the requester profile so comms edits apply to queued tasks.
export const TaskThreadParticipantsSchema = z.object({
  /** Humans in the thread, including those past the cap. */
  total: z.number().int(),
  /** Humans past the cap, rendered as `<N more...>`. */
  more: z.number().int(),
  people: z.array(
    z.object({
      /** `<@U…|Name> (role)`, with `(external, untrusted)` / `(unknown user, untrusted)` tags. */
      label: z.string(),
      trust: SlackParticipantTrustSchema,
      starter: z.boolean().optional(),
      newest: z.boolean().optional(),
      asked: z.boolean().optional(),
      /** Notes for a non-primary internal person; never tone or notes. */
      language: z.string().optional(),
      verbosity: z.string().optional(),
    }),
  ),
  /** Full profile of the internal person who started the work, when not the newest sender. */
  starterProfile: TaskRequestedBySchema.optional(),
});
export type TaskThreadParticipants = z.infer<typeof TaskThreadParticipantsSchema>;

/**
 * Participants block for a Slack task. Undefined unless the thread has two or
 * more humans or any untrusted participant, so a single internal person costs
 * no tokens.
 */
export async function buildTaskThreadParticipants(task: {
  slackParticipants?: TaskSlackParticipants;
}): Promise<TaskThreadParticipants | undefined> {
  const stored = task.slackParticipants;
  if (!stored || stored.people.length === 0) return undefined;
  const total = stored.people.length + stored.more;
  if (total < 2 && !stored.people.some((person) => isUntrusted(person.trust))) return undefined;

  let starterProfile: TaskThreadParticipants["starterProfile"];
  const people = await Promise.all(
    stored.people.map(async (person) => {
      const user = person.userId ? await getUserById(person.userId) : undefined;
      const identity = await resolveIdentity("slack", person.slackUserId);
      const untrusted = isUntrusted(person.trust);
      const tags = [
        identity.status === "resolved" ? undefined : "unknown user",
        untrusted && identity.status === "resolved" ? person.trust : undefined,
        !untrusted ? user?.role : undefined,
        untrusted ? "untrusted" : undefined,
      ].filter(Boolean);
      const mention =
        identity.status === "resolved"
          ? `<@${person.slackUserId}|${identity.name}>`
          : `<@${person.slackUserId}>`;
      const comms = user && !untrusted ? getUserCommsPrefs(user) : undefined;
      if (person.starter && !person.newest && !untrusted && user) {
        starterProfile = {
          id: user.id,
          name: user.name,
          role: user.role,
          notes: getRequesterNotes(user.notes),
          comms,
        };
      }
      const primary = person.starter || person.newest;
      return {
        label: tags.length > 0 ? `${mention} (${tags.join(", ")})` : mention,
        trust: person.trust,
        ...(person.starter && { starter: true }),
        ...(person.newest && { newest: true }),
        ...(person.asked && { asked: true }),
        ...(!primary && cut(comms?.language) && { language: cut(comms?.language) }),
        ...(!primary && cut(comms?.verbosity) && { verbosity: cut(comms?.verbosity) }),
      };
    }),
  );
  return { total, more: stored.more, people, ...(starterProfile && { starterProfile }) };
}
