import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentFsProvider,
  agentFsUploadTimeoutMs,
  FilesError,
  LocalFsProvider,
  normalizeFilesError,
  resetFileStorageProviderForTests,
  selectProvider,
} from "../fs";

const originalEnv = { ...process.env };

// Stands in for a provider that accepts the connection and never answers: the
// promise only settles when the provider's own AbortController fires.
const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener("abort", () => {
      const aborted = new Error("The operation was aborted.");
      aborted.name = "AbortError";
      reject(aborted);
    });
  })) as unknown as typeof fetch;

const partialAgentFsScopeError = {
  code: "Provider",
  status: 400,
  message: "agent-fs file scope must include both orgId and driveId, or neither",
};

afterEach(() => {
  process.env = { ...originalEnv };
  resetFileStorageProviderForTests();
});

describe("LocalFsProvider", () => {
  test("round-trips upload, head, download, list, copy, move, and delete", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-swarm-fs-"));
    try {
      const provider = new LocalFsProvider({ rootDir });
      const scope = { taskId: "task-1", name: "inputs/hello.txt" };

      const uploaded = await provider.upload(
        scope,
        new Blob(["hello world"], { type: "text/plain" }),
      );
      expect(uploaded.providerId).toBe("local-fs");
      expect(uploaded.key).toBe("tasks/task-1/inputs/hello.txt");
      expect(uploaded.sizeBytes).toBe(11);

      const head = await provider.head(scope);
      expect(head.name).toBe(scope.name);
      expect(head.sizeBytes).toBe(11);
      expect(await provider.exists(scope)).toBe(true);

      const downloaded = await provider.download(scope);
      expect(await downloaded.text()).toBe("hello world");

      const listed = await provider.list({ taskId: "task-1" });
      expect(listed.map((item) => item.name)).toEqual(["inputs/hello.txt"]);

      await provider.copy(scope, { taskId: "task-1", name: "copies/hello.txt" });
      expect(
        await (await provider.download({ taskId: "task-1", name: "copies/hello.txt" })).text(),
      ).toBe("hello world");

      await provider.move(
        { taskId: "task-1", name: "copies/hello.txt" },
        { taskId: "task-1", name: "moved/hello.txt" },
      );
      expect(await provider.exists({ taskId: "task-1", name: "copies/hello.txt" })).toBe(false);
      expect(await provider.exists({ taskId: "task-1", name: "moved/hello.txt" })).toBe(true);

      await provider.delete(scope);
      expect(await provider.exists(scope)).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("resolves an explicit stored key verbatim and rejects traversal", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-swarm-fs-"));
    try {
      const provider = new LocalFsProvider({ rootDir });
      // Write at the forward-looking layout, then read back via an explicit stored key
      // that does NOT match tasks/<taskId>/<name> reconstruction.
      await provider.upload({ taskId: "task-9", name: "report.md" }, new Blob(["stored-key body"]));
      const storedKey = "tasks/task-9/report.md";
      const viaKey = await provider.download({
        taskId: "other",
        name: "unrelated",
        key: storedKey,
      });
      expect(await viaKey.text()).toBe("stored-key body");

      await expect(
        provider.download({ taskId: "t", name: "n", key: "../../etc/passwd" }),
      ).rejects.toMatchObject({ code: "Provider" });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("head() returns the real upload Content-Type, not an extension guess from the storage key", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "agent-swarm-fs-"));
    try {
      const provider = new LocalFsProvider({ rootDir });
      // Storage key has no extension Bun can sniff correctly from — the JPEG bytes
      // would otherwise be mis-reported (e.g. application/octet-stream or worse).
      const scope = { taskId: "task-1", name: "attachment-blob" };

      const uploaded = await provider.upload(scope, new Blob([new Uint8Array([1, 2, 3])]), {
        contentType: "image/jpeg",
      });
      expect(uploaded.contentType).toBe("image/jpeg");

      const head = await provider.head(scope);
      expect(head.contentType).toBe("image/jpeg");

      // copy() must carry the stored Content-Type forward too.
      const copied = await provider.copy(scope, { taskId: "task-1", name: "attachment-copy" });
      expect(copied.contentType).toBe("image/jpeg");

      // The sidecar metadata file must not surface as a listed file.
      const listed = await provider.list({ taskId: "task-1" });
      expect(listed.map((item) => item.name).sort()).toEqual([
        "attachment-blob",
        "attachment-copy",
      ]);

      await provider.delete(scope);
      expect(await provider.exists(scope)).toBe(false);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  });

  test("signedUploadUrl throws a normalized ReadOnly error", async () => {
    const provider = new LocalFsProvider({
      rootDir: await mkdtemp(join(tmpdir(), "agent-swarm-fs-")),
    });
    await expect(
      provider.signedUploadUrl({ taskId: "task-1", name: "file.txt" }),
    ).rejects.toMatchObject({
      code: "ReadOnly",
    });
  });
});

describe("AgentFsProvider", () => {
  test("uploads binary bytes to the raw endpoint with conditional headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "org-1",
      driveId: "drive-1",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return new Response(
          JSON.stringify({
            version: 7,
            path: "tasks/task-1/file.bin",
            contentHash: "hash-1",
            deduped: false,
          }),
          {
            status: 200,
            headers: {
              etag: "7",
              "x-agent-fs-version": "7",
              "x-agent-fs-content-hash": "hash-1",
            },
          },
        );
      }) as typeof fetch,
    });

    const result = await provider.upload(
      { taskId: "task-1", name: "file.bin" },
      new Uint8Array([1, 2, 3]),
      { contentType: "application/octet-stream", ifNoneMatch: "*", message: "upload" },
    );

    expect(result.version).toBe("7");
    expect(result.sha256).toBe("hash-1");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(
      "http://agent-fs.test/orgs/org-1/drives/drive-1/files/tasks/task-1/file.bin/raw",
    );
    expect(calls[0]?.init.method).toBe("PUT");
    expect(new Headers(calls[0]?.init.headers).get("authorization")).toBe("Bearer af_test");
    expect(new Headers(calls[0]?.init.headers).get("if-none-match")).toBe("*");
    expect(new Headers(calls[0]?.init.headers).get("x-agent-fs-message")).toBe("upload");
    expect(calls[0]?.init.body).toBeInstanceOf(Uint8Array);
  });

  test("dispatches capability methods through the ops endpoint", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "org-1",
      driveId: "drive-1",
      fetchImpl: (async (url, init) => {
        calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
        return Response.json([{ path: "tasks/task-1/file.txt", score: 0.5 }]);
      }) as typeof fetch,
    });

    await provider.search({ taskId: "task-1", query: "hello", limit: 3 });
    await provider.listComments({ taskId: "task-1", name: "file.txt" });
    await provider.listVersions({ taskId: "task-1", name: "file.txt" });

    expect(calls.map((call) => call.url)).toEqual([
      "http://agent-fs.test/orgs/org-1/ops",
      "http://agent-fs.test/orgs/org-1/ops",
      "http://agent-fs.test/orgs/org-1/ops",
    ]);
    expect(calls.map((call) => (call.body as { op: string }).op)).toEqual([
      "search",
      "comment-list",
      "log",
    ]);
    expect(calls.every((call) => (call.body as { driveId: string }).driveId === "drive-1")).toBe(
      true,
    );
  });

  test("download rejects partial scopes and resolves default and paired scopes", async () => {
    const calls: string[] = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "default-org",
      driveId: "default-drive",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return new Response("bytes");
      }) as typeof fetch,
    });

    for (const partialScope of [
      { taskId: "task-1", name: "notes.md", orgId: "row-org" },
      { taskId: "task-1", name: "notes.md", driveId: "row-drive" },
    ]) {
      await expect(provider.download(partialScope)).rejects.toMatchObject(partialAgentFsScopeError);
    }
    expect(calls).toHaveLength(0);

    await provider.download({ taskId: "task-1", name: "default.md" });
    await provider.download({
      taskId: "task-1",
      name: "notes.md",
      key: "misc/d454d1a5/notes.md",
      orgId: "row-org",
      driveId: "row-drive",
    });

    expect(calls).toEqual([
      "http://agent-fs.test/orgs/default-org/drives/default-drive/files/tasks/task-1/default.md/raw",
      "http://agent-fs.test/orgs/row-org/drives/row-drive/files/misc/d454d1a5/notes.md/raw",
    ]);
  });

  test("signed URL rejects partial scopes and resolves default and paired scopes", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "default-org",
      driveId: "default-drive",
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ url: "https://signed.example/x" });
      }) as typeof fetch,
    });

    for (const partialScope of [
      { taskId: "task-1", name: "notes.md", orgId: "row-org" },
      { taskId: "task-1", name: "notes.md", driveId: "row-drive" },
    ]) {
      await expect(provider.url(partialScope)).rejects.toMatchObject(partialAgentFsScopeError);
    }
    expect(calls).toHaveLength(0);

    await provider.url({ taskId: "task-1", name: "default.md" }, { expiresIn: 600 });
    await provider.url(
      {
        taskId: "task-1",
        name: "notes.md",
        key: "misc/d454d1a5/notes.md",
        orgId: "row-org",
        driveId: "row-drive",
      },
      { expiresIn: 600 },
    );

    expect(calls).toEqual([
      {
        url: "http://agent-fs.test/orgs/default-org/ops",
        body: {
          driveId: "default-drive",
          op: "signed-url",
          path: "tasks/task-1/default.md",
          expiresIn: 600,
        },
      },
      {
        url: "http://agent-fs.test/orgs/row-org/ops",
        body: {
          driveId: "row-drive",
          op: "signed-url",
          path: "misc/d454d1a5/notes.md",
          expiresIn: 600,
        },
      },
    ]);
  });

  test("delete rejects partial scopes and resolves default and paired scopes", async () => {
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "default-org",
      driveId: "default-drive",
      fetchImpl: (async (url, init) => {
        calls.push({
          url: String(url),
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({});
      }) as typeof fetch,
    });

    for (const partialScope of [
      { taskId: "task-1", name: "notes.md", orgId: "row-org" },
      { taskId: "task-1", name: "notes.md", driveId: "row-drive" },
    ]) {
      await expect(provider.delete(partialScope)).rejects.toMatchObject(partialAgentFsScopeError);
    }
    expect(calls).toHaveLength(0);

    await provider.delete({ taskId: "task-1", name: "default.md" });
    await provider.delete({
      taskId: "task-1",
      name: "notes.md",
      key: "misc/d454d1a5/notes.md",
      orgId: "row-org",
      driveId: "row-drive",
    });

    expect(calls).toEqual([
      {
        url: "http://agent-fs.test/orgs/default-org/ops",
        body: {
          driveId: "default-drive",
          op: "rm",
          path: "tasks/task-1/default.md",
        },
      },
      {
        url: "http://agent-fs.test/orgs/row-org/ops",
        body: {
          driveId: "row-drive",
          op: "rm",
          path: "misc/d454d1a5/notes.md",
        },
      },
    ]);
  });

  test("stored key strips leading slashes and falls back to the provider's org/drive", async () => {
    const calls: string[] = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "default-org",
      driveId: "default-drive",
      fetchImpl: (async (url) => {
        calls.push(String(url));
        return new Response("bytes", { status: 200 });
      }) as typeof fetch,
    });

    // Leading-slash stored key, no per-row org/drive → default org/drive, no double slash.
    await provider.download({ taskId: "t", name: "A2.md", key: "/smoke/A2-with-ids.md" });

    expect(calls[0]).toBe(
      "http://agent-fs.test/orgs/default-org/drives/default-drive/files/smoke/A2-with-ids.md/raw",
    );
  });

  test("missing configuration throws a provider error", () => {
    expect(
      () =>
        new AgentFsProvider({
          apiUrl: "http://agent-fs.test",
          apiKey: "af_test",
          orgId: "",
          driveId: "",
        }),
    ).toThrow(FilesError);
  });

  test("upload aborts with a Timeout error once the deadline passes", async () => {
    process.env.AGENT_FS_REQUEST_TIMEOUT_MS = "50";
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "org-1",
      driveId: "drive-1",
      fetchImpl: hangingFetch,
    });

    const startedAt = performance.now();
    await expect(
      provider.upload({ taskId: "task-1", name: "file.bin" }, new Uint8Array([1, 2, 3])),
    ).rejects.toMatchObject({ code: "Timeout" });
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("ops calls abort with a Timeout error once the deadline passes", async () => {
    process.env.AGENT_FS_REQUEST_TIMEOUT_MS = "50";
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "org-1",
      driveId: "drive-1",
      fetchImpl: hangingFetch,
    });

    const startedAt = performance.now();
    await expect(provider.delete({ taskId: "task-1", name: "file.bin" })).rejects.toMatchObject({
      code: "Timeout",
      message: "agent-fs did not respond within 50 ms",
    });
    expect(performance.now() - startedAt).toBeLessThan(1000);
  });

  test("a request that settles clears its deadline timer", async () => {
    const clearSpy = spyOn(globalThis, "clearTimeout");
    try {
      const provider = new AgentFsProvider({
        apiUrl: "http://agent-fs.test",
        apiKey: "af_test",
        orgId: "org-1",
        driveId: "drive-1",
        fetchImpl: (async () => Response.json({ version: 3 })) as typeof fetch,
      });

      const result = await provider.upload(
        { taskId: "task-1", name: "file.bin" },
        new Uint8Array([1]),
      );

      expect(result.version).toBe("3");
      expect(clearSpy).toHaveBeenCalled();
    } finally {
      clearSpy.mockRestore();
    }
  });
});

describe("agentFsUploadTimeoutMs", () => {
  test("adds a size allowance of one ms per 256 bytes on top of the base deadline", () => {
    delete process.env.AGENT_FS_REQUEST_TIMEOUT_MS;
    expect(agentFsUploadTimeoutMs(0)).toBe(20_000);
    expect(agentFsUploadTimeoutMs(300_000)).toBe(20_000 + 1172);
    expect(agentFsUploadTimeoutMs(50 * 1024 * 1024)).toBe(20_000 + 204_800);
  });

  test("honours AGENT_FS_REQUEST_TIMEOUT_MS and ignores unusable values", () => {
    process.env.AGENT_FS_REQUEST_TIMEOUT_MS = "5000";
    expect(agentFsUploadTimeoutMs(0)).toBe(5_000);
    process.env.AGENT_FS_REQUEST_TIMEOUT_MS = "not-a-number";
    expect(agentFsUploadTimeoutMs(0)).toBe(20_000);
    process.env.AGENT_FS_REQUEST_TIMEOUT_MS = "0";
    expect(agentFsUploadTimeoutMs(0)).toBe(20_000);
  });
});

describe("normalizeFilesError", () => {
  test("maps abort and timeout errors to the Timeout code", () => {
    for (const name of ["AbortError", "TimeoutError"]) {
      const error = new Error("The operation timed out.");
      error.name = name;
      expect(normalizeFilesError(error)).toMatchObject({ code: "Timeout" });
    }
  });

  test("keeps other errors on the Provider code", () => {
    expect(normalizeFilesError(new Error("socket closed"))).toMatchObject({ code: "Provider" });
  });
});

describe("selectProvider", () => {
  test("defaults to local-fs without agent-fs env", () => {
    delete process.env.AGENT_FS_API_URL;
    delete process.env.API_AGENT_FS_API_KEY;
    delete process.env.AGENT_FS_API_KEY;
    expect(selectProvider().id).toBe("local-fs");
  });

  test("selects agent-fs when required env is present", () => {
    process.env.AGENT_FS_API_URL = "http://agent-fs.test";
    process.env.API_AGENT_FS_API_KEY = "af_test";
    process.env.AGENT_FS_DEFAULT_ORG_ID = "org-1";
    process.env.AGENT_FS_DEFAULT_DRIVE_ID = "drive-1";
    expect(selectProvider().id).toBe("agent-fs");
  });
});
