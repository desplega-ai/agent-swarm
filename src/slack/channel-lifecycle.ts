import type { WebClient } from "@slack/web-api";
import { slackCode } from "@/slack/channel-join";

export type CreateChannelResult = {
  channelId: string;
  name: string;
};

export type InviteToChannelResult = {
  alreadyInChannel: boolean;
};

export type ArchiveChannelResult = {
  alreadyArchived: boolean;
};

export function normalizeChannelName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "")
    .slice(0, 80)
    .replace(/[-_]+$/g, "");

  if (!normalized) {
    throw new Error("Slack channel name must contain at least one letter or number.");
  }

  return normalized;
}

export async function createChannel(
  client: WebClient,
  { name, isPrivate = false }: { name: string; isPrivate?: boolean },
): Promise<CreateChannelResult> {
  const normalizedName = normalizeChannelName(name);

  try {
    const result = await client.conversations.create({
      name: normalizedName,
      is_private: isPrivate,
    });
    const channelId = result.channel?.id;
    if (!channelId) {
      throw new Error("Slack created the channel but did not return its ID.");
    }

    return { channelId, name: normalizedName };
  } catch (error) {
    if (slackCode(error) === "name_taken") {
      throw new Error(`Slack channel name "${normalizedName}" is already taken.`);
    }
    throw error;
  }
}

export async function inviteToChannel(
  client: WebClient,
  channelId: string,
  userIds: string[],
): Promise<InviteToChannelResult> {
  if (userIds.length === 0) {
    throw new Error("At least one Slack user ID is required.");
  }

  try {
    await client.conversations.invite({
      channel: channelId,
      users: userIds.join(","),
    });
    return { alreadyInChannel: false };
  } catch (error) {
    if (slackCode(error) !== "already_in_channel") {
      throw error;
    }

    let allAlreadyInChannel = true;
    for (const userId of userIds) {
      try {
        await client.conversations.invite({ channel: channelId, users: userId });
        allAlreadyInChannel = false;
      } catch (userError) {
        if (slackCode(userError) !== "already_in_channel") {
          throw userError;
        }
      }
    }

    return { alreadyInChannel: allAlreadyInChannel };
  }
}

export async function archiveChannel(
  client: WebClient,
  channelId: string,
): Promise<ArchiveChannelResult> {
  try {
    await client.conversations.archive({ channel: channelId });
    return { alreadyArchived: false };
  } catch (error) {
    const code = slackCode(error);
    if (code === "already_archived") {
      return { alreadyArchived: true };
    }
    if (code === "cant_archive_general") {
      throw new Error("Slack's general channel cannot be archived.");
    }
    if (code === "cant_archive_required") {
      throw new Error("This required Slack channel cannot be archived.");
    }
    throw error;
  }
}
