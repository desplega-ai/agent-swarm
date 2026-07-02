import { describe, expect, it } from "bun:test";
import { materializeCodexAuthJson } from "../providers/codex-oauth/auth-json-fs.js";
import type { CodexOAuthCredentials } from "../providers/codex-oauth/types.js";

const mockCreds: CodexOAuthCredentials = {
  access: "at_testaccess",
  refresh: "rt_testrefresh",
  expires: new Date("2026-12-31T00:00:00Z").getTime(),
  accountId: "acc-test-12345",
};

describe("materializeCodexAuthJson", () => {
  it("writes auth.json via tmp → rename (atomic pattern)", async () => {
    const writes: Array<{ path: string; content: string }> = [];
    const renames: Array<{ from: string; to: string }> = [];
    const mkdirs: string[] = [];

    await materializeCodexAuthJson(0, mockCreds, {
      homedir: () => "/home/testworker",
      fs: {
        mkdir: async (path) => {
          mkdirs.push(path);
          return undefined;
        },
        writeFile: async (path, data) => {
          writes.push({ path, content: data });
        },
        rename: async (from, to) => {
          renames.push({ from, to });
        },
      },
    });

    // mkdir called for .codex dir
    expect(mkdirs).toContain("/home/testworker/.codex");

    // Write goes to .tmp path
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe("/home/testworker/.codex/auth.json.tmp");

    // Rename from tmp to final
    expect(renames).toHaveLength(1);
    expect(renames[0]!.from).toBe("/home/testworker/.codex/auth.json.tmp");
    expect(renames[0]!.to).toBe("/home/testworker/.codex/auth.json");
  });

  it("writes valid auth.json content", async () => {
    let writtenContent = "";

    await materializeCodexAuthJson(2, mockCreds, {
      homedir: () => "/home/testworker",
      fs: {
        mkdir: async () => undefined,
        writeFile: async (_path, data) => {
          writtenContent = data;
        },
        rename: async () => {},
      },
    });

    const parsed = JSON.parse(writtenContent) as {
      auth_mode: string;
      tokens: {
        access_token: string;
        refresh_token: string;
        account_id: string;
      };
    };
    expect(parsed.auth_mode).toBe("chatgpt");
    expect(parsed.tokens.access_token).toBe("at_testaccess");
    expect(parsed.tokens.refresh_token).toBe("rt_testrefresh");
    expect(parsed.tokens.account_id).toBe("acc-test-12345");
  });

  it("rename is called after writeFile (atomic ordering)", async () => {
    const order: string[] = [];

    await materializeCodexAuthJson(1, mockCreds, {
      homedir: () => "/home/testworker",
      fs: {
        mkdir: async () => undefined,
        writeFile: async () => {
          order.push("write");
        },
        rename: async () => {
          order.push("rename");
        },
      },
    });

    expect(order).toEqual(["write", "rename"]);
  });

  it("slot parameter does not affect output path (auth.json is always the target)", async () => {
    const paths: string[] = [];

    for (const slot of [0, 3, 9]) {
      paths.length = 0;
      await materializeCodexAuthJson(slot, mockCreds, {
        homedir: () => "/home/w",
        fs: {
          mkdir: async () => undefined,
          writeFile: async (path) => {
            paths.push(path);
          },
          rename: async () => {},
        },
      });
      expect(paths[0]).toBe("/home/w/.codex/auth.json.tmp");
    }
  });
});
