import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/status-labels", () => require("../../lib/status-labels"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/spinner", () => require("../ui/spinner"));
mock.module("@/components/kibo-ui/spinner", () => require("../kibo-ui/spinner"));
mock.module("@/components/shared/task-status-icon", () => require("./task-status-icon"));

const { StatusBadge } = await import("./status-badge");
const { STATUS_LABELS, statusLabel } = await import("../../lib/status-labels");

describe("StatusBadge", () => {
  test("in progress is amber, the live color", () => {
    const html = renderToStaticMarkup(<StatusBadge status="in_progress" />);
    expect(html).toContain("IN PROGRESS");
    expect(html).toContain("text-status-active-strong");
    expect(html).not.toContain("status-info");
  });

  test("cancelled is neutral, not an error", () => {
    const html = renderToStaticMarkup(<StatusBadge status="cancelled" />);
    expect(html).toContain("text-status-neutral-strong");
    expect(html).not.toContain("status-error");
  });

  test("draft reads as uploading, its real meaning in this product", () => {
    expect(renderToStaticMarkup(<StatusBadge status="draft" />)).toContain("UPLOADING");
  });

  test("agent health keeps its dot", () => {
    const html = renderToStaticMarkup(<StatusBadge status="idle" />);
    expect(html).toContain("bg-status-success");
    expect(html).not.toContain('data-slot="task-status-icon"');
  });
});

describe("statusLabel", () => {
  test("every chip label has a sentence-case form", () => {
    for (const [status, chip] of Object.entries(STATUS_LABELS)) {
      const label = statusLabel(status);
      expect(label.toUpperCase()).toBe(chip);
      expect(label.slice(1)).toBe(label.slice(1).toLowerCase());
    }
  });

  test("raw values never show", () => {
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusLabel("draft")).toBe("Uploading");
    expect(statusLabel("some_new_state")).toBe("Some new state");
  });
});
