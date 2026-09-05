import { describe, expect, test } from "bun:test";
import {
  diffIdentityFields,
  IDENTITY_FIELD_PATHS,
  type IdentityFileIo,
  materializeRefreshedIdentityFiles,
  refreshIdentityIfChanged,
} from "../commands/identity-refresh";
import { contentSha256, type IdentityBaselines } from "../commands/profile-sync";

const TOOLS_PATH = IDENTITY_FIELD_PATHS.toolsMd;

/** In-memory FS double that records every write. */
function makeIo(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const writes: string[] = [];
  const io: IdentityFileIo = {
    read: async (path) => files[path],
    write: async (path, content) => {
      files[path] = content;
      writes.push(path);
    },
  };
  return { io, files, writes };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const CTX = { apiUrl: "http://api.test", apiKey: "k", agentId: "agent-1", role: "worker" };

describe("diffIdentityFields", () => {
  test("reports only the fields whose server value differs", () => {
    expect(
      diffIdentityFields(
        { toolsMd: "old", soulMd: "same", name: "Coder" },
        { toolsMd: "new", soulMd: "same", name: "Coder" },
      ),
    ).toEqual(["toolsMd"]);
  });

  test("a field the server omits is never a change (partial payloads must not blank the prompt)", () => {
    expect(diffIdentityFields({ toolsMd: "old", soulMd: "soul" }, { toolsMd: "old" })).toEqual([]);
  });

  test("a field appearing for the first time counts as a change", () => {
    expect(diffIdentityFields({}, { heartbeatMd: "beat" })).toEqual(["heartbeatMd"]);
  });

  test("identical profiles produce no changes", () => {
    const same = { soulMd: "s", identityMd: "i", toolsMd: "t", claudeMd: "c", name: "n" };
    expect(diffIdentityFields(same, { ...same })).toEqual([]);
  });
});

describe("materializeRefreshedIdentityFiles", () => {
  test("rewrites a file that still matches its session baseline", async () => {
    const { io, files, writes } = makeIo({ [TOOLS_PATH]: "boot" });
    const baselines: IdentityBaselines = { toolsMd: contentSha256("boot") };

    const result = await materializeRefreshedIdentityFiles(
      ["toolsMd"],
      { toolsMd: "fresh" },
      baselines,
      io,
    );

    expect(writes).toEqual([TOOLS_PATH]);
    expect(files[TOOLS_PATH]).toBe("fresh");
    expect(result.written).toEqual([TOOLS_PATH]);
    expect(result.baselines.toolsMd).toBe(contentSha256("fresh"));
  });

  test("leaves an in-session agent edit alone and keeps its baseline for session-end sync", async () => {
    const { io, files, writes } = makeIo({ [TOOLS_PATH]: "agent edit" });
    const bootHash = contentSha256("boot");

    const result = await materializeRefreshedIdentityFiles(
      ["toolsMd"],
      { toolsMd: "fresh" },
      { toolsMd: bootHash },
      io,
    );

    expect(writes).toEqual([]);
    expect(files[TOOLS_PATH]).toBe("agent edit");
    expect(result.skipped).toEqual([TOOLS_PATH]);
    expect(result.baselines.toolsMd).toBe(bootHash);
  });

  test("re-baselines without writing when the file already holds the new content", async () => {
    const { io, writes } = makeIo({ [TOOLS_PATH]: "fresh" });

    const result = await materializeRefreshedIdentityFiles(
      ["toolsMd"],
      { toolsMd: "fresh" },
      { toolsMd: contentSha256("boot") },
      io,
    );

    expect(writes).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.baselines.toolsMd).toBe(contentSha256("fresh"));
  });

  test("materializes a missing file", async () => {
    const { io, files } = makeIo();

    const result = await materializeRefreshedIdentityFiles(
      ["toolsMd"],
      { toolsMd: "fresh" },
      null,
      io,
    );

    expect(files[TOOLS_PATH]).toBe("fresh");
    expect(result.written).toEqual([TOOLS_PATH]);
  });

  test("without a baseline, a differing file is treated as a local edit and preserved", async () => {
    const { io, files, writes } = makeIo({ [TOOLS_PATH]: "local" });

    const result = await materializeRefreshedIdentityFiles(
      ["toolsMd"],
      { toolsMd: "fresh" },
      null,
      io,
    );

    expect(writes).toEqual([]);
    expect(files[TOOLS_PATH]).toBe("local");
    expect(result.skipped).toEqual([TOOLS_PATH]);
  });

  test("ignores non-file fields (name/description have no workspace path)", async () => {
    const { io, writes } = makeIo();

    const result = await materializeRefreshedIdentityFiles(
      ["name", "description"],
      { name: "Coder", description: "ships code" },
      null,
      io,
    );

    expect(writes).toEqual([]);
    expect(result.written).toEqual([]);
    expect(result.skipped).toEqual([]);
  });

  test("preserves baselines for fields it did not touch", async () => {
    const { io } = makeIo({ [TOOLS_PATH]: "boot" });
    const soulHash = contentSha256("soul");

    const result = await materializeRefreshedIdentityFiles(
      ["toolsMd"],
      { toolsMd: "fresh" },
      { toolsMd: contentSha256("boot"), soulMd: soulHash },
      io,
    );

    expect(result.baselines.soulMd).toBe(soulHash);
  });
});

describe("refreshIdentityIfChanged", () => {
  test("returns the fresh value when the DB moved on after boot", async () => {
    const { io, files } = makeIo({ [TOOLS_PATH]: "boot tools" });
    const persisted: IdentityBaselines[] = [];

    const result = await refreshIdentityIfChanged(
      {
        ...CTX,
        fetchImpl: async () => jsonResponse({ toolsMd: "fresh tools", soulMd: "soul" }),
        io,
        readBaselines: async () => ({ toolsMd: contentSha256("boot tools") }),
        writeBaselines: async (b) => {
          persisted.push(b);
        },
      },
      { toolsMd: "boot tools", soulMd: "soul" },
    );

    expect(result.changed).toBe(true);
    expect(result.changedFields).toEqual(["toolsMd"]);
    expect(result.fields.toolsMd).toBe("fresh tools");
    expect(result.fields.soulMd).toBe("soul");
    expect(files[TOOLS_PATH]).toBe("fresh tools");
    expect(persisted[0]?.toolsMd).toBe(contentSha256("fresh tools"));
  });

  test("reports no change when the profile matches the cache", async () => {
    const cached = { toolsMd: "same", soulMd: "same" };
    const result = await refreshIdentityIfChanged(
      { ...CTX, fetchImpl: async () => jsonResponse(cached) },
      cached,
    );

    expect(result.changed).toBe(false);
    expect(result.fields).toBe(cached);
    expect(result.changedFields).toEqual([]);
  });

  test("a non-2xx response leaves the cached prompt untouched", async () => {
    const cached = { toolsMd: "cached" };
    const result = await refreshIdentityIfChanged(
      { ...CTX, fetchImpl: async () => new Response("nope", { status: 503 }) },
      cached,
    );

    expect(result.changed).toBe(false);
    expect(result.fields).toBe(cached);
  });

  test("a thrown fetch never propagates", async () => {
    const cached = { toolsMd: "cached" };
    const result = await refreshIdentityIfChanged(
      {
        ...CTX,
        fetchImpl: async () => {
          throw new Error("network down");
        },
      },
      cached,
    );

    expect(result.changed).toBe(false);
    expect(result.fields.toolsMd).toBe("cached");
  });

  test("still surfaces the fresh prompt content when the file write fails", async () => {
    const result = await refreshIdentityIfChanged(
      {
        ...CTX,
        fetchImpl: async () => jsonResponse({ toolsMd: "fresh" }),
        io: {
          read: async () => undefined,
          write: async () => {
            throw new Error("read-only fs");
          },
        },
        readBaselines: async () => null,
        writeBaselines: async () => {},
      },
      { toolsMd: "boot" },
    );

    expect(result.changed).toBe(true);
    expect(result.fields.toolsMd).toBe("fresh");
  });

  test("sends the agent id and bearer on the profile read", async () => {
    let seen: Record<string, string> = {};
    await refreshIdentityIfChanged(
      {
        ...CTX,
        fetchImpl: async (_url, init) => {
          seen = (init?.headers ?? {}) as Record<string, string>;
          return jsonResponse({ toolsMd: "boot" });
        },
      },
      { toolsMd: "boot" },
    );

    expect(seen["X-Agent-ID"]).toBe("agent-1");
    expect(seen.Authorization).toBe("Bearer k");
  });
});
