import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, type ReactNode } from "react";
import type { FormField } from "./catalog";
import {
  fileFieldValue,
  fileUploadPath,
  type PendingFiles,
  resolveFileFields,
  sanitizeFileName,
} from "./form-file-model";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

const NOW = new Date("2026-11-06T12:15:00.123Z");
const STAMP = "20261106T121500123Z";

/** A fake upload: records each call in order, fails for paths listed in `failing`. */
function fakeUploader(failing: string[] = []) {
  const log: string[] = [];
  const upload = async (path: string, file: File) => {
    log.push(`upload ${path} (${file.size}b)`);
    if (failing.some((name) => path.endsWith(name))) {
      throw new Error("Larger than the agent-fs upload limit");
    }
    return path;
  };
  return { log, upload };
}

const contract: FormField = {
  name: "contract",
  label: "Contract",
  kind: "file",
  dir: "/apps/deals/uploads",
  required: true,
};

describe("file names", () => {
  test("sanitizes to a safe, non-empty name", () => {
    expect(sanitizeFileName("Q3 Contract (final).pdf")).toBe("Q3-Contract-final-.pdf");
    expect(sanitizeFileName("résumé.pdf")).toBe("resume.pdf");
    expect(sanitizeFileName("../../etc/passwd")).toBe("etc-passwd");
    expect(sanitizeFileName("???")).toBe("file");
  });

  test("uploads land at <dir>/<timestamp>-<name>", () => {
    expect(fileUploadPath("/apps/deals/uploads/", "a b.pdf", NOW)).toBe(
      `/apps/deals/uploads/${STAMP}-a-b.pdf`,
    );
    expect(fileUploadPath("/d", "x.png", NOW, 1, 2)).toBe(`/d/${STAMP}-2-x.png`);
  });

  test("$form value: a path, or an array with multiple", () => {
    expect(fileFieldValue(contract, ["/a"])).toBe("/a");
    expect(fileFieldValue(contract, [])).toBeUndefined();
    expect(fileFieldValue({ ...contract, multiple: true }, ["/a", "/b"])).toEqual(["/a", "/b"]);
  });
});

describe("resolveFileFields (the submit step before the chain)", () => {
  test("uploads pending files and returns their paths for $form", async () => {
    const { log, upload } = fakeUploader();
    const pending: PendingFiles = { contract: [new File(["%PDF"], "deal.pdf")] };
    const result = await resolveFileFields({
      fields: [contract],
      read: () => undefined,
      pending,
      upload,
      now: NOW,
    });
    const path = `/apps/deals/uploads/${STAMP}-deal.pdf`;
    expect(log).toEqual([`upload ${path} (4b)`]);
    expect(result).toEqual({ ok: true, values: { contract: path }, writes: { contract: path } });
  });

  test("the chain runs only after every upload resolved", async () => {
    const order: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const submit = (async () => {
      const result = await resolveFileFields({
        fields: [contract],
        read: () => undefined,
        pending: { contract: [new File(["x"], "a.pdf")] },
        upload: async (path) => {
          order.push("upload started");
          await gate;
          order.push("upload done");
          return path;
        },
        now: NOW,
      });
      if (result.ok) order.push(`chain $form.contract=${String(result.values.contract)}`);
    })();
    await Promise.resolve();
    expect(order).toEqual(["upload started"]);
    release();
    await submit;
    expect(order).toEqual([
      "upload started",
      "upload done",
      `chain $form.contract=/apps/deals/uploads/${STAMP}-a.pdf`,
    ]);
  });

  test("multiple appends uploads to attached paths", async () => {
    const { upload } = fakeUploader();
    const result = await resolveFileFields({
      fields: [{ ...contract, multiple: true }],
      read: () => ["/apps/deals/old.pdf"],
      pending: { contract: [new File(["1"], "a.pdf"), new File(["2"], "b.pdf")] },
      upload,
      now: NOW,
    });
    expect(result.ok && result.values.contract).toEqual([
      "/apps/deals/old.pdf",
      `/apps/deals/uploads/${STAMP}-1-a.pdf`,
      `/apps/deals/uploads/${STAMP}-2-b.pdf`,
    ]);
  });

  test("an upload failure stops before the chain and keeps the pending file", async () => {
    const { upload } = fakeUploader(["big.pdf"]);
    const result = await resolveFileFields({
      fields: [contract],
      read: () => undefined,
      pending: { contract: [new File(["x"], "big.pdf")] },
      upload,
      now: NOW,
    });
    expect(result).toEqual({
      ok: false,
      error: "Could not upload big.pdf: Larger than the agent-fs upload limit",
      writes: {},
    });
  });

  test("a field that uploaded before a later failure keeps its stored path", async () => {
    const { upload } = fakeUploader(["b.pdf"]);
    const result = await resolveFileFields({
      fields: [contract, { ...contract, name: "annex", label: "Annex" }],
      read: () => undefined,
      pending: { contract: [new File(["x"], "a.pdf")], annex: [new File(["y"], "b.pdf")] },
      upload,
      now: NOW,
    });
    expect(result.ok).toBe(false);
    expect(result.writes).toEqual({ contract: `/apps/deals/uploads/${STAMP}-a.pdf` });
  });

  test("a required field with nothing attached is an error, with no upload", async () => {
    const { log, upload } = fakeUploader();
    const result = await resolveFileFields({
      fields: [contract],
      read: () => null,
      pending: {},
      upload,
    });
    expect(result).toEqual({ ok: false, error: "Contract is required", writes: {} });
    expect(log).toEqual([]);
  });

  test("pick mode: an attached path passes through with no upload", async () => {
    const { log, upload } = fakeUploader();
    const result = await resolveFileFields({
      fields: [{ ...contract, source: "pick", dir: undefined }],
      read: () => "/apps/deals/existing.pdf",
      pending: {},
      upload,
    });
    expect(result).toEqual({
      ok: true,
      values: { contract: "/apps/deals/existing.pdf" },
      writes: {},
    });
    expect(log).toEqual([]);
  });

  test("not connected: pending files cannot upload", async () => {
    const result = await resolveFileFields({
      fields: [contract],
      read: () => undefined,
      pending: { contract: [new File(["x"], "a.pdf")] },
      upload: null,
    });
    expect(result).toEqual({ ok: false, error: "Connect agent-fs to upload files", writes: {} });
  });
});

// ─── FormFileField ──────────────────────────────────────────────────────────

// `./files` reads agent-fs; stand in a connected gate and a one-row browser.
const browsed: { path: string; mode?: string }[] = [];
let connected = true;
mock.module("./files", () => ({
  AgentFsGate: ({ children }: { children: (drive: object) => ReactNode }) =>
    connected ? (
      children({ orgId: "org-1", driveId: "drive-1" })
    ) : (
      <div data-testid="connect-card" />
    ),
  FilesView: ({
    props,
    onSelect,
  }: {
    props: { path: string; mode?: string };
    onSelect: (row: { path: string; type: string }) => void;
  }) => {
    browsed.push({ path: props.path, mode: props.mode });
    return (
      <div>
        <button
          type="button"
          data-testid="pick-dir"
          onClick={() => onSelect({ path: "/apps/deals/sub/", type: "directory" })}
        >
          sub
        </button>
        <button
          type="button"
          data-testid="pick-file"
          onClick={() => onSelect({ path: "/apps/deals/existing.pdf", type: "file" })}
        >
          existing.pdf
        </button>
      </div>
    );
  },
}));
mock.module("@/contexts/agent-fs-context", () => ({ useOptionalAgentFs: () => null }));
mock.module("@/lib/agent-fs/query", () => ({ agentFsKey: (...parts: unknown[]) => parts }));
mock.module("@/components/comb/file-icon", () => ({ FileKindIcon: () => <span /> }));
mock.module("@/components/ui/button", () => require("../../components/ui/button"));
mock.module("@/components/ui/dialog", () => require("../../components/ui/dialog"));
mock.module("@/lib/format-bytes", () => require("../format-bytes"));
mock.module("@/lib/utils", () => require("../utils"));

const { FormFileField } = await import("./form-file");

type Change = { paths: string[]; files: File[] };

async function mountField(field: FormField, state: { paths?: string[]; files?: File[] } = {}) {
  const changes: Change[] = [];
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(
      <FormFileField
        field={field}
        inputId="f"
        paths={state.paths ?? []}
        files={state.files ?? []}
        onChange={(next) => changes.push(next)}
      />,
    );
  });
  return { host, changes };
}

const button = (label: string) =>
  [...document.querySelectorAll("button")].find((b) => b.textContent?.includes(label));

async function click(element: Element | null | undefined) {
  if (!element) throw new Error("nothing to click");
  await act(async () => {
    (element as HTMLElement).click();
  });
}

beforeEach(() => {
  document.body.innerHTML = "";
  browsed.length = 0;
  connected = true;
});

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

describe("FormFileField", () => {
  test("upload source: a file input with accept, and no picker", async () => {
    const { host } = await mountField({ ...contract, accept: [".pdf", "image/*"] });
    const input = host.querySelector<HTMLInputElement>(
      '[data-testid="json-render-form-file-input"]',
    );
    expect(input?.accept).toBe(".pdf,image/*");
    expect(input?.multiple).toBe(false);
    expect(button("Pick from agent-fs")).toBeUndefined();
  });

  test("pick mode browses dir and attaches a file, not a folder", async () => {
    const { host, changes } = await mountField({ ...contract, source: "pick" });
    expect(host.querySelector('[data-testid="json-render-form-file-input"]')).toBeNull();
    await click(button("Pick from agent-fs"));
    expect(browsed.at(-1)).toEqual({ path: "/apps/deals/uploads", mode: "browser" });
    await click(document.querySelector('[data-testid="pick-dir"]'));
    expect(changes).toEqual([]);
    await click(document.querySelector('[data-testid="pick-file"]'));
    expect(changes).toEqual([{ paths: ["/apps/deals/existing.pdf"], files: [] }]);
  });

  test("single: picking replaces a pending upload", async () => {
    const pending = new File(["x"], "draft.pdf");
    const { changes } = await mountField({ ...contract, source: "both" }, { files: [pending] });
    expect(document.body.textContent).toContain("draft.pdf");
    await click(button("Pick from agent-fs"));
    await click(document.querySelector('[data-testid="pick-file"]'));
    expect(changes).toEqual([{ paths: ["/apps/deals/existing.pdf"], files: [] }]);
  });

  test("remove drops an attached path", async () => {
    const { changes } = await mountField(contract, { paths: ["/apps/deals/a.pdf"] });
    await click(document.querySelector('[aria-label="Remove a.pdf"]'));
    expect(changes).toEqual([{ paths: [], files: [] }]);
  });

  test("not connected: the connect card instead of the field", async () => {
    connected = false;
    const { host } = await mountField(contract);
    expect(host.querySelector('[data-testid="connect-card"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="json-render-form-file"]')).toBeNull();
  });
});
