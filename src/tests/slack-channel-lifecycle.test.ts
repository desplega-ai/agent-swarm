import { describe, expect, mock, test } from "bun:test";
import type { WebClient } from "@slack/web-api";
import {
  archiveChannel,
  createChannel,
  inviteToChannel,
  normalizeChannelName,
} from "../slack/channel-lifecycle";

function makePlatformError(code: string): Error {
  const error = new Error(`An API error occurred: ${code}`);
  (error as unknown as { data: { error: string } }).data = { error: code };
  return error;
}

function makeClient(
  overrides: { create?: () => unknown; invite?: () => unknown; archive?: () => unknown } = {},
) {
  const create = mock(
    overrides.create ?? (() => Promise.resolve({ channel: { id: "C123", name: "project-alpha" } })),
  );
  const invite = mock(overrides.invite ?? (() => Promise.resolve({ ok: true })));
  const archive = mock(overrides.archive ?? (() => Promise.resolve({ ok: true })));
  const client = { conversations: { create, invite, archive } } as unknown as WebClient;

  return { client, create, invite, archive };
}

describe("Slack channel lifecycle", () => {
  test("normalizes channel names to Slack's naming rules", () => {
    expect(normalizeChannelName("  Project.Alpha / Launch!  ")).toBe("project-alpha-launch");
    expect(normalizeChannelName(`A${"B".repeat(100)}`)).toHaveLength(80);
  });

  test("rejects a name that normalizes to an empty value", () => {
    expect(() => normalizeChannelName("... !!!")).toThrow("at least one letter or number");
  });

  test("creates a channel with the normalized name and returns it", async () => {
    const { client, create } = makeClient();

    const result = await createChannel(client, { name: "Project.Alpha", isPrivate: true });

    expect(result).toEqual({ channelId: "C123", name: "project-alpha" });
    expect(create).toHaveBeenCalledWith({ name: "project-alpha", is_private: true });
  });

  test("surfaces name_taken with the normalized name", async () => {
    const { client } = makeClient({
      create: () => {
        throw makePlatformError("name_taken");
      },
    });

    await expect(createChannel(client, { name: "Project.Alpha" })).rejects.toThrow(
      'Slack channel name "project-alpha" is already taken.',
    );
  });

  test("treats already_in_channel as invite success", async () => {
    const { client, invite } = makeClient({
      invite: () => {
        throw makePlatformError("already_in_channel");
      },
    });

    const result = await inviteToChannel(client, "C123", ["U1", "U2"]);

    expect(result).toEqual({ alreadyInChannel: true });
    expect(invite).toHaveBeenCalledTimes(3);
    expect(invite).toHaveBeenNthCalledWith(1, { channel: "C123", users: "U1,U2" });
    expect(invite).toHaveBeenNthCalledWith(2, { channel: "C123", users: "U1" });
    expect(invite).toHaveBeenNthCalledWith(3, { channel: "C123", users: "U2" });
  });

  test("retries a mixed already_in_channel batch so new users are still invited", async () => {
    const inviteResults = [
      () => {
        throw makePlatformError("already_in_channel");
      },
      () => {
        throw makePlatformError("already_in_channel");
      },
      () => Promise.resolve({ ok: true }),
    ];
    const { client, invite } = makeClient({
      invite: () => inviteResults.shift()?.(),
    });

    const result = await inviteToChannel(client, "C123", ["U1", "U2"]);

    expect(result).toEqual({ alreadyInChannel: false });
    expect(invite).toHaveBeenNthCalledWith(2, { channel: "C123", users: "U1" });
    expect(invite).toHaveBeenNthCalledWith(3, { channel: "C123", users: "U2" });
  });

  test("treats already_archived as archive success", async () => {
    const { client, archive } = makeClient({
      archive: () => {
        throw makePlatformError("already_archived");
      },
    });

    const result = await archiveChannel(client, "C123");

    expect(result).toEqual({ alreadyArchived: true });
    expect(archive).toHaveBeenCalledWith({ channel: "C123" });
  });

  test("explains that Slack's general channel cannot be archived", async () => {
    const { client } = makeClient({
      archive: () => {
        throw makePlatformError("cant_archive_general");
      },
    });

    await expect(archiveChannel(client, "CGENERAL")).rejects.toThrow(
      "Slack's general channel cannot be archived.",
    );
  });
});
