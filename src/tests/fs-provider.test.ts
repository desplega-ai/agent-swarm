import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AgentFsProvider,
  FilesError,
  LocalFsProvider,
  resetFileStorageProviderForTests,
  selectProvider,
} from "../fs";

const originalEnv = { ...process.env };

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

  test("download/delete/signed-url resolve the row's stored key + org/drive override", async () => {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const provider = new AgentFsProvider({
      apiUrl: "http://agent-fs.test",
      apiKey: "af_test",
      orgId: "default-org",
      driveId: "default-drive",
      fetchImpl: (async (url, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : undefined;
        calls.push({ url: String(url), method: init?.method ?? "GET", body });
        return Response.json({ url: "https://signed.example/x" });
      }) as typeof fetch,
    });

    // An attachment written via the CLI at an arbitrary path, in the row's own org/drive.
    const scope = {
      taskId: "task-1",
      name: "notes.md",
      key: "misc/d454d1a5/notes.md",
      orgId: "row-org",
      driveId: "row-drive",
    };

    await provider.download(scope);
    await provider.delete(scope);
    await provider.url(scope, { expiresIn: 600 });

    // download hits the raw endpoint at the STORED key under the ROW's org/drive.
    expect(calls[0]?.url).toBe(
      "http://agent-fs.test/orgs/row-org/drives/row-drive/files/misc/d454d1a5/notes.md/raw",
    );
    // delete + signed-url go through the row's org's ops endpoint with its drive + key.
    expect(calls[1]?.url).toBe("http://agent-fs.test/orgs/row-org/ops");
    expect(calls[1]?.body).toMatchObject({
      driveId: "row-drive",
      op: "rm",
      path: "misc/d454d1a5/notes.md",
    });
    expect(calls[2]?.body).toMatchObject({
      driveId: "row-drive",
      op: "signed-url",
      path: "misc/d454d1a5/notes.md",
    });
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
