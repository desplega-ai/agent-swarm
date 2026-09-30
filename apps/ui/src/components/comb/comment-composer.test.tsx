import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act, useLayoutEffect } from "react";

// A DOM for the composer; removed after this file so other files keep their
// server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
mock.module("@radix-ui/react-use-layout-effect", () => ({ useLayoutEffect }));

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/kbd", () => require("../ui/kbd"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/lib/comb/comments", () => require("../../lib/comb/comments"));
mock.module("@/lib/comb/drafts", () => require("../../lib/comb/drafts"));

// `comment-add`: records the params, then fails with `nextError` when set.
let nextError: unknown = null;
const sent: unknown[] = [];
mock.module("@/api/hooks/use-agent-fs", () => ({
  useAddComment: () => ({
    isPending: false,
    mutateAsync: async (params: unknown) => {
      sent.push(params);
      if (nextError) throw nextError;
      return {};
    },
  }),
}));

const { createRoot } = await import("react-dom/client");
const { toast } = await import("sonner");
const { AgentFsError } = await import("../../lib/agent-fs/client");
const { CommentContextProvider } = await import("./comment-context");
const { CommentComposer } = await import("./comment-composer");
const { draftStorageKey, writeDraft } = await import("../../lib/comb/drafts");
const { collectMentionIds } = await import("../../lib/comb/mentions");
type ComposerExtrasContext = import("./comment-composer").ComposerExtrasContext;

const toastError = spyOn(toast, "error").mockImplementation(() => 0);
const toastWarning = spyOn(toast, "warning").mockImplementation(() => 0);
afterAll(async () => {
  toastError.mockRestore();
  toastWarning.mockRestore();
  await GlobalRegistrator.unregister();
});

const FILE = { orgId: "org-1", driveId: "drive-1", path: "/comb-qa/notes.md" };
const SCOPE = {
  apiUrl: "http://localhost:3013",
  endpoint: "http://localhost:7433",
  userId: "user-1",
  ...FILE,
};

async function renderComposer(
  opts: { readOnly?: boolean; renderComposerExtras?: (ctx: ComposerExtrasContext) => null } = {},
) {
  const outboxAdds: Array<[unknown, string]> = [];
  const markReadOnly = mock(() => {});
  const onClose = mock(() => {});
  const value = {
    file: FILE as never,
    scope: SCOPE,
    outbox: {
      entries: [],
      sending: new Set<string>(),
      add: (params: unknown, error: string) => void outboxAdds.push([params, error]),
      discard: () => {},
      retry: async () => {},
      retryAll: async () => {},
    },
    readOnly: opts.readOnly ?? false,
    markReadOnly,
  };
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <CommentContextProvider value={value}>
        <CommentComposer
          target={{ kind: "file" }}
          onClose={onClose}
          renderComposerExtras={opts.renderComposerExtras}
        />
      </CommentContextProvider>,
    ),
  );
  return { container, root, outboxAdds, markReadOnly, onClose };
}

async function typeAndSend(container: HTMLElement, text: string) {
  const textarea = container.querySelector("textarea");
  if (!textarea) throw new Error("no textarea");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, text);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await clickSend(container);
}

async function clickSend(container: HTMLElement) {
  const send = [...container.querySelectorAll("button")].find((b) =>
    b.textContent?.includes("Send"),
  );
  if (!send) throw new Error("no Send button");
  await act(async () => send.click());
}

describe("CommentComposer send errors", () => {
  beforeEach(() => {
    nextError = null;
    sent.length = 0;
    toastError.mockClear();
    toastWarning.mockClear();
    localStorage.clear();
  });

  test("a sent comment closes the composer", async () => {
    const { container, onClose, root } = await renderComposer();
    await typeAndSend(container, "Tighten this");
    expect(sent).toEqual([{ path: "comb-qa/notes.md", body: "Tighten this" }]);
    expect(onClose).toHaveBeenCalledTimes(1);
    await act(async () => root.unmount());
  });

  test("a 403 marks the rail read-only and says so", async () => {
    nextError = new AgentFsError(403, "FORBIDDEN", "viewer");
    const { container, markReadOnly, onClose, outboxAdds, root } = await renderComposer();
    await typeAndSend(container, "Tighten this");
    expect(markReadOnly).toHaveBeenCalledTimes(1);
    expect(toastError).toHaveBeenCalledWith("You have view-only access");
    expect(outboxAdds).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  test("a 5xx or a network error keeps the comment in the outbox and says so", async () => {
    for (const error of [
      new AgentFsError(503, "UNAVAILABLE", "agent-fs is down"),
      new AgentFsError(0, "NETWORK", "offline"),
    ]) {
      nextError = error;
      toastWarning.mockClear();
      const { container, onClose, outboxAdds, root } = await renderComposer();
      await typeAndSend(container, "Tighten this");
      expect(outboxAdds).toEqual([
        [{ path: "comb-qa/notes.md", body: "Tighten this" }, error.message],
      ]);
      expect(toastWarning).toHaveBeenCalledWith("Not sent. Kept in Comments.");
      expect(onClose).toHaveBeenCalledTimes(1);
      await act(async () => root.unmount());
    }
  });

  test("another 4xx shows inline and keeps the text", async () => {
    nextError = new AgentFsError(400, "VALIDATION", "Comment is too long");
    const { container, onClose, outboxAdds, root } = await renderComposer();
    await typeAndSend(container, "Tighten this");
    expect(container.querySelector('[role="alert"]')?.textContent).toBe("Comment is too long");
    expect(container.querySelector("textarea")?.value).toBe("Tighten this");
    expect(outboxAdds).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    await act(async () => root.unmount());
  });

  test("read-only renders no composer (the rail shows the notice)", async () => {
    const { container, root } = await renderComposer({ readOnly: true });
    expect(container.querySelector("textarea")).toBeNull();
    await act(async () => root.unmount());
  });
});

describe("CommentComposer picked mentions (step-8)", () => {
  beforeEach(() => {
    nextError = null;
    sent.length = 0;
    localStorage.clear();
  });

  // The mention picker's send hook (`mention-picker.tsx`), without the list.
  const mentionExtras = (ctx: ComposerExtrasContext) => {
    ctx.sendParamsRef.current = (text) => {
      const mentions = collectMentionIds(text, ctx.picked);
      return mentions.length > 0 ? { mentions } : {};
    };
    return null;
  };
  const draftKey = draftStorageKey(SCOPE, "file");

  test("a restored draft keeps its picks, and a typed name mentions nobody", async () => {
    const body = "@Ann Lee is on it, ask @admin";
    writeDraft(localStorage, draftKey, body, Date.now(), new Map([["Ann", "u-ann"]]));
    const { container, root } = await renderComposer({ renderComposerExtras: mentionExtras });
    expect(container.querySelector("textarea")?.value).toBe(body);
    await clickSend(container);
    expect(sent).toEqual([{ path: "comb-qa/notes.md", body, mentions: ["u-ann"] }]);
    await act(async () => root.unmount());
  });

  test("the outbox entry keeps the picked mentions, and the draft goes", async () => {
    nextError = new AgentFsError(503, "UNAVAILABLE", "agent-fs is down");
    writeDraft(
      localStorage,
      draftKey,
      "@Ann can you check?",
      Date.now(),
      new Map([["Ann", "u-ann"]]),
    );
    const { container, outboxAdds, root } = await renderComposer({
      renderComposerExtras: mentionExtras,
    });
    await clickSend(container);
    expect(outboxAdds).toEqual([
      [
        { path: "comb-qa/notes.md", body: "@Ann can you check?", mentions: ["u-ann"] },
        "agent-fs is down",
      ],
    ]);
    expect(localStorage.getItem(draftKey)).toBeNull();
    await act(async () => root.unmount());
  });
});
