import { describe, expect, test } from "bun:test";
import { getSlackSocketModeBlockReason, SLACK_DEV_SOCKET_MODE_OPT_IN } from "./socket-mode-guard";

describe("Slack Socket Mode boot guard", () => {
  test("blocks a development-shaped boot by default", () => {
    expect(getSlackSocketModeBlockReason({ NODE_ENV: "development" })).toBe(
      "NODE_ENV=development marks this as a dev/throwaway run",
    );
  });

  test("allows the production image boot shape", () => {
    expect(
      getSlackSocketModeBlockReason({ DATABASE_PATH: "/app/data/agent-swarm-db.sqlite" }),
    ).toBeNull();
  });

  test("allows an explicitly opted-in development boot", () => {
    expect(
      getSlackSocketModeBlockReason({
        NODE_ENV: "development",
        [SLACK_DEV_SOCKET_MODE_OPT_IN]: "true",
      }),
    ).toBeNull();
  });
});
