import { describe, expect, mock, test } from "bun:test";
import type { ColDef } from "ag-grid-community";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { AgentTask } from "@/api/types";

mock.module("@/components/shared/task-hover-card", () => ({ TaskHoverCard: () => null }));
mock.module("@/components/shared/markdown-view", () => ({ MarkdownView: () => null }));
mock.module("@/components/shared/agent-avatar", () => ({ AgentAvatar: () => null }));
mock.module("@/components/shared/columns-menu", () => ({ ColumnsMenu: () => null }));
mock.module("@/api/hooks/use-feature-gate", () => ({ useFeatureGate: () => true }));
mock.module("@/components/shared/bitbucket-mark", () => ({ BitbucketMark: () => null }));
mock.module("@/api/types", () => require("../../api/types"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/lib/model-vendor", () => require("../../lib/model-vendor"));
mock.module("@/lib/model-tiers", () => require("../../lib/model-tiers"));
mock.module("@/lib/task-model-resolution", () => require("../../lib/task-model-resolution"));
mock.module("@/lib/task-title", () => require("../../lib/task-title"));
mock.module("@/lib/cost-format", () => require("../../lib/cost-format"));
mock.module("@/components/shared/harness-icon", () => require("./harness-icon"));
mock.module("@/components/shared/model-logo", () => require("./model-logo"));
mock.module("@/components/shared/model-effort-label", () => require("./model-effort-label"));
mock.module("@/components/shared/effort-mark", () => require("./effort-mark"));
mock.module("@/components/shared/reasoning-effort-icon", () => require("./reasoning-effort-icon"));
mock.module("@/components/shared/status-badge", () => ({ StatusBadge: () => null }));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
let profiles: import("../../api/types").ModelProfile[] | undefined;
mock.module("@/api/hooks/use-model-profiles", () => ({
  useModelProfiles: () => ({ data: profiles }),
}));
mock.module("@/api/hooks/use-models-catalog", () => ({
  useModelsCatalog: () => ({ data: undefined }),
}));
mock.module("@/api/hooks/use-users", () => ({
  useUsers: () => ({ data: undefined }),
}));
mock.module("@/components/shared/data-grid", () => ({
  DataGrid: ({ rowData, columnDefs }: { rowData: AgentTask[]; columnDefs: ColDef[] }) => {
    const renderCell = columnDefs.find((column) => column.field === "model")?.cellRenderer;
    return <div data-testid="model-cell">{renderCell({ data: rowData[0] })}</div>;
  },
}));
// Render tooltip content separately from its trigger so assertions distinguish
// the visible cell label from information available only on hover.
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TooltipContent: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
}));
const { TasksTable } = await import("./tasks-table");

function renderModel(task: Partial<AgentTask>) {
  return renderToStaticMarkup(
    <TasksTable
      rowData={[task as AgentTask]}
      columns={{
        isHidden: (id) => id !== "model",
        forcedHidden: new Set(),
        gateHidden: new Set(),
        toggle: () => {},
      }}
    />,
  );
}

function expectProfileOnHover(html: string, profile: string) {
  const [cell, tooltip] = html.split("<aside>");
  expect(cell).toContain("Claude Opus 5.5");
  expect(cell).not.toContain(profile);
  expect(cell).not.toContain("Model profile:");
  expect(tooltip).toContain(`Profile: ${profile}`);
  expect(tooltip?.match(/Profile:/g)).toHaveLength(1);
}

describe("tasks table model cell", () => {
  test("claimed models show their resolved profile only in the tooltip", () => {
    expectProfileOnHover(
      renderModel({
        resolvedModel: "claude-opus-5-5",
        resolvedProfile: "claude-opus-5-5-high",
        resolvedEffort: "high",
      }),
      "claude-opus-5-5-high",
    );
  });

  test("models without a claim-time resolution retain their profile on hover", () => {
    expectProfileOnHover(
      renderModel({ model: "claude-opus-5-5", profile: "claude-opus-5-5-high", effort: "high" }),
      "claude-opus-5-5-high",
    );
  });

  test("custom profiles keep a logo chip with their original casing and description", () => {
    profiles = [
      {
        name: "Review Team",
        harness: "codex",
        model: "gpt-6.1-sol",
        seededFrom: null,
        description: "Code review",
      } as import("../../api/types").ModelProfile,
    ];
    const html = renderModel({ resolvedModel: "gpt-6.1-sol", resolvedProfile: "Review Team" });
    const cell = html.split("<aside>")[0];
    expect(cell).toContain("Review Team");
    expect(cell).toContain("normal-case");
    expect(cell).toContain("<svg");
    expect(cell).toContain("Model profile: Review Team: Code review");
    profiles = undefined;
  });

  test("catalog seed metadata wins even for names the heuristic would keep", () => {
    profiles = [
      { name: "Old default", seededFrom: "agent-config" } as import("../../api/types").ModelProfile,
    ];
    const html = renderModel({ resolvedModel: "claude-opus-5-5", resolvedProfile: "Old default" });
    expectProfileOnHover(html, "Old default");
    profiles = undefined;
  });

  test("profile-only tasks retain their visible fallback chip", () => {
    const html = renderModel({ profile: "Custom review" });
    expect(html).toContain('title="Model profile: Custom review"');
    expect(html).not.toContain("<aside>");
  });
});
