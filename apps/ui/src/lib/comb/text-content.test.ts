import { describe, expect, test } from "bun:test";
import { COMB_TEXT_MAX_BYTES, readDriveText } from "./text-content";

const FILE = { orgId: "org-1", driveId: "drive-1", path: "/notes/big.log" };

function fakeClient(body: string) {
  const calls: string[] = [];
  return {
    calls,
    client: {
      fetchRaw: async (_orgId: string, _driveId: string, path: string) => {
        calls.push(path);
        return new Blob([body]);
      },
    },
  };
}

describe("readDriveText", () => {
  test("the cap is 2 MiB", () => {
    expect(COMB_TEXT_MAX_BYTES).toBe(2 * 1024 * 1024);
  });

  test("a file above 2 MiB is tooLarge and is not fetched", async () => {
    const { client, calls } = fakeClient("never read");
    const result = await readDriveText(client, FILE, { size: COMB_TEXT_MAX_BYTES + 1 });
    expect(result).toEqual({ tooLarge: true, text: null });
    expect(calls).toEqual([]);
  });

  test("a file of exactly 2 MiB still loads", async () => {
    const { client, calls } = fakeClient("line 1\nline 2\n");
    const result = await readDriveText(client, FILE, { size: COMB_TEXT_MAX_BYTES });
    expect(result).toEqual({ tooLarge: false, text: "line 1\nline 2\n" });
    expect(calls).toEqual(["/notes/big.log"]);
  });
});
