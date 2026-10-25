import { describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_UPLOAD_BYTES,
  type DropEntry,
  dropSources,
  filesFromDrop,
  formatLimit,
  keepBothName,
  keepBothPath,
  MAX_CONCURRENT_UPLOADS,
  type PutFn,
  type UploadItem,
  UploadQueue,
  type UploadSummary,
  uploadLimitBytes,
  uploadTargetPath,
} from "./upload";

describe("uploadTargetPath", () => {
  test("joins the folder and the dropped path", () => {
    expect(uploadTargetPath("/docs/", "a.png")).toBe("/docs/a.png");
    expect(uploadTargetPath("/", "a.png")).toBe("/a.png");
    expect(uploadTargetPath("/docs", "shots/a.png")).toBe("/docs/shots/a.png");
  });

  test("a name never leaves the folder", () => {
    expect(uploadTargetPath("/docs/", "../../etc/passwd")).toBe("/docs/etc/passwd");
    expect(uploadTargetPath("/docs/", "./a//b\\c.txt")).toBe("/docs/a/b/c.txt");
    expect(uploadTargetPath("/docs/", "/abs.txt")).toBe("/docs/abs.txt");
  });
});

describe("keepBothName", () => {
  const none = new Set<string>();

  test("adds a counter before the extension", () => {
    expect(keepBothName("photo.png", none)).toBe("photo (1).png");
    expect(keepBothName("archive.tar.gz", none)).toBe("archive.tar (1).gz");
  });

  test("names without an extension, and dotfiles, get the counter at the end", () => {
    expect(keepBothName("Makefile", none)).toBe("Makefile (1)");
    expect(keepBothName(".env", none)).toBe(".env (1)");
  });

  test("skips taken names and counts on from an existing counter", () => {
    expect(keepBothName("photo.png", new Set(["photo (1).png", "photo (2).png"]))).toBe(
      "photo (3).png",
    );
    expect(keepBothName("photo (1).png", none)).toBe("photo (2).png");
    expect(keepBothName("photo (9).png", new Set(["photo (10).png"]))).toBe("photo (11).png");
  });

  test("keepBothPath keeps the folder", () => {
    expect(keepBothPath("/docs/a.md", new Set(["a.md"]))).toBe("/docs/a (1).md");
    expect(keepBothPath("/a.md", new Set())).toBe("/a (1).md");
  });
});

describe("upload limit", () => {
  test("uses the server's limit, else agent-fs's 50 MB default", () => {
    expect(uploadLimitBytes(10)).toBe(10);
    expect(uploadLimitBytes(null)).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(uploadLimitBytes(0)).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(uploadLimitBytes(1.5)).toBe(DEFAULT_MAX_UPLOAD_BYTES);
    expect(formatLimit(DEFAULT_MAX_UPLOAD_BYTES)).toBe("50 MB");
    expect(formatLimit(1.5 * 1024 * 1024)).toBe("1.5 MB");
  });
});

const DRIVE = { orgId: "org", driveId: "drive" };

function file(name: string, size = 3): File {
  return new File([new Uint8Array(size)], name);
}

function fileEntry(name: string): DropEntry {
  return { isFile: true, isDirectory: false, name, file: (ok) => ok(file(name)) };
}

function dirEntry(name: string, children: DropEntry[], batch = 2): DropEntry {
  return {
    isFile: false,
    isDirectory: true,
    name,
    createReader: () => {
      let offset = 0;
      return {
        readEntries: (ok) => {
          ok(children.slice(offset, offset + batch));
          offset += batch;
        },
      };
    },
  };
}

describe("filesFromDrop", () => {
  test("keeps a dropped folder's structure and reads every batch", async () => {
    const inputs = await filesFromDrop(
      [
        fileEntry("top.txt"),
        dirEntry("shots", [
          fileEntry("a.png"),
          fileEntry("b.png"),
          dirEntry("old", [fileEntry("c.png")]),
        ]),
      ],
      [],
    );
    expect(inputs.map((input) => input.relativePath)).toEqual([
      "top.txt",
      "shots/a.png",
      "shots/b.png",
      "shots/old/c.png",
    ]);
  });

  test("dropSources reads file items only, so a page drag's string items do not shift the files", async () => {
    const png = file("photo.png");
    const items = [
      { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
      { kind: "string", webkitGetAsEntry: () => null, getAsFile: () => null },
      { kind: "file", webkitGetAsEntry: () => null, getAsFile: () => png },
    ];
    const { entries, files } = dropSources(items);
    expect(entries).toEqual([null]);
    expect(files).toEqual([png]);
    const inputs = await filesFromDrop(entries, files);
    expect(inputs.map((input) => input.relativePath)).toEqual(["photo.png"]);
  });

  test("falls back to the plain file when an item has no entry", async () => {
    const inputs = await filesFromDrop([null], [file("loose.txt")]);
    expect(inputs.map((input) => input.relativePath)).toEqual(["loose.txt"]);
  });
});

interface Deferred {
  resolve: () => void;
  reject: (error: unknown) => void;
  signal: AbortSignal;
  path: string;
}

function harness() {
  const calls: Deferred[] = [];
  const summaries: UploadSummary[] = [];
  const conflict = new Error("conflict");
  const aborted = new Error("aborted");
  const queue = new UploadQueue({
    isConflict: (error) => error === conflict,
    isAbort: (error) => error === aborted,
    onDrained: (summary) => summaries.push(summary),
  });
  const put: PutFn = (path, _file, { signal, onProgress }) =>
    new Promise((resolve, reject) => {
      onProgress(0.5);
      signal.addEventListener("abort", () => reject(aborted));
      calls.push({ resolve: () => resolve({ version: 1 }), reject, signal, path });
    });
  const status = () => queue.getItems().map((item: UploadItem) => item.status);
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  return { queue, put, calls, summaries, conflict, status, settle };
}

describe("UploadQueue", () => {
  test("runs at most 3 at a time and summarizes the batch once", async () => {
    const { queue, put, calls, summaries, status, settle } = harness();
    queue.enqueue(
      DRIVE,
      ["a", "b", "c", "d"].map((name) => ({ file: file(name), path: `/up/${name}` })),
      put,
      100,
    );
    expect(calls.length).toBe(MAX_CONCURRENT_UPLOADS);
    expect(status()).toEqual(["uploading", "uploading", "uploading", "queued"]);
    expect(queue.getItems()[0]?.progress).toBe(0.5);
    for (const call of calls.slice(0, 3)) call.resolve();
    await settle();
    expect(calls.length).toBe(4);
    calls[3]?.resolve();
    await settle();
    expect(status()).toEqual(["done", "done", "done", "done"]);
    expect(summaries).toEqual([{ done: 4, failed: 0 }]);
  });

  test("rejects a file over the limit before sending it", () => {
    const { queue, put, calls, status } = harness();
    queue.enqueue(DRIVE, [{ file: file("big", 11), path: "/big" }], put, 10);
    expect(calls.length).toBe(0);
    expect(status()).toEqual(["rejected"]);
    expect(queue.getItems()[0]?.error).toBe(`Larger than ${formatLimit(10)}`);
  });

  test("a clash waits; Keep both sends it again under the new name", async () => {
    const { queue, put, calls, summaries, conflict, status, settle } = harness();
    queue.enqueue(DRIVE, [{ file: file("a.md"), path: "/docs/a.md" }], put, 100);
    calls[0]?.reject(conflict);
    await settle();
    expect(status()).toEqual(["conflict"]);
    expect(summaries).toEqual([]);
    const id = queue.getItems()[0]?.id as number;
    queue.keepBoth(id, "/docs/a (1).md");
    expect(calls[1]?.path).toBe("/docs/a (1).md");
    calls[1]?.resolve();
    await settle();
    expect(status()).toEqual(["done"]);
    expect(queue.getItems()[0]?.path).toBe("/docs/a (1).md");
    expect(summaries).toEqual([{ done: 1, failed: 0 }]);
  });

  test("Keep both and Skip act on a waiting clash only", async () => {
    const { queue, put, calls, conflict, status, settle } = harness();
    queue.enqueue(DRIVE, [{ file: file("a.md"), path: "/a.md" }], put, 100);
    calls[0]?.reject(conflict);
    await settle();
    const id = queue.getItems()[0]?.id as number;
    // Skip lands before a slow Keep both: the file stays skipped.
    queue.skip(id);
    queue.keepBoth(id, "/a (1).md");
    expect(status()).toEqual(["skipped"]);
    expect(calls.length).toBe(1);
    expect(queue.getItems()[0]?.drive).toEqual(DRIVE);
  });

  test("a second Keep both does not upload twice", async () => {
    const { queue, put, calls, conflict, settle } = harness();
    queue.enqueue(DRIVE, [{ file: file("a.md"), path: "/a.md" }], put, 100);
    calls[0]?.reject(conflict);
    await settle();
    const id = queue.getItems()[0]?.id as number;
    queue.keepBoth(id, "/a (1).md");
    queue.keepBoth(id, "/a (1).md");
    expect(calls.length).toBe(2);
  });

  test("Skip, cancel, and errors", async () => {
    const { queue, put, calls, summaries, conflict, status, settle } = harness();
    queue.enqueue(
      DRIVE,
      ["a", "b", "c"].map((name) => ({ file: file(name), path: `/${name}` })),
      put,
      100,
    );
    const [a, b] = queue.getItems();
    calls[0]?.reject(conflict);
    calls[2]?.reject(new Error("disk full"));
    await settle();
    queue.skip(a?.id as number);
    queue.cancel(b?.id as number);
    await settle();
    expect(status()).toEqual(["skipped", "skipped", "error"]);
    expect(queue.getItems()[2]?.error).toBe("disk full");
    expect(summaries).toEqual([{ done: 0, failed: 1 }]);
    queue.clearFinished();
    expect(queue.getItems()).toEqual([]);
  });
});
