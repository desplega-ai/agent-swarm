import { afterAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";

// A DOM for client re-renders; removed after this file so other files keep
// their server-render environment.
GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { act } = await import("react");
const { createRoot } = await import("react-dom/client");
const { MemoryRouter } = await import("react-router-dom");
const { CombMarkdown } = await import("./comb-markdown");

afterAll(async () => {
  await GlobalRegistrator.unregister();
});

const DOC = { orgId: "org-1", driveId: "drive-1", path: "/comb-qa/notes.md" };

test("a new version with the same line lengths renders its new text", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const render = (text: string) =>
    act(async () => {
      root.render(
        <MemoryRouter>
          <CombMarkdown text={text} doc={DOC} />
        </MemoryRouter>,
      );
    });

  await render("# QA\n\nBurst edit 10 of 20.\n");
  expect(container.textContent).toContain("Burst edit 10 of 20.");
  // Streamdown memoizes each block by its source position only, so this
  // paragraph (same line, same columns) kept the old text before the fix.
  await render("# QA\n\nBurst edit 11 of 20.\n");
  expect(container.textContent).toContain("Burst edit 11 of 20.");
  expect(container.textContent).not.toContain("Burst edit 10 of 20.");

  await act(async () => root.unmount());
  container.remove();
});
