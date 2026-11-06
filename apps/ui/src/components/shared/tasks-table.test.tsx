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
mock.module("@/components/ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  TooltipContent: () => null,
}));
// Render the card's inputs next to its trigger so assertions distinguish the
// visible cell from what the details card receives.
mock.module("@/components/shared/model-details-card", () => ({
  ModelDetailsCard: ({
    children,
    label,
    profile,
  }: {
    children: ReactNode;
    label: string;
    profile?: { name: string };
  }) => (
    <>
      <span data-card={label}>{children}</span>
      <aside>{profile ? `definition:${profile.name}` : "definition:none"}</aside>
    </>
  ),
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

function cellOf(html: string): string {
  return html.split("<aside>")[0] ?? "";
}

describe("tasks table model cell", () => {
  test("claimed models show logo, name and effort only; the profile moves to the card", () => {
    const html = renderModel({
      id: "t1",
      resolvedModel: "claude-opus-5-5",
      resolvedProfile: "claude-opus-5-5-high",
      resolvedEffort: "high",
    });
    const cell = cellOf(html);
    expect(cell).toContain('data-card="claude-opus-5-5"');
    expect(cell).toContain("Claude Opus 5.5");
    expect(cell).toContain("High effort");
    expect(cell).not.toContain("claude-opus-5-5-high");
  });

  test("custom profiles no longer squeeze the name with a chip", () => {
    profiles = [
      {
        name: "Review Team",
        harness: "codex",
        model: "gpt-6.1-sol",
        seededFrom: null,
        description: "Code review",
      } as import("../../api/types").ModelProfile,
    ];
    const html = renderModel({
      id: "t2",
      resolvedModel: "gpt-6.1-sol",
      resolvedProfile: "Review Team",
    });
    expect(cellOf(html)).not.toContain("Review Team");
    expect(html).toContain("<aside>definition:Review Team</aside>");
    profiles = undefined;
  });

  test("unclaimed tasks keep their tier and profile visible", () => {
    const html = renderModel({ id: "t3", modelTier: "smart", profile: "Custom review" });
    const cell = cellOf(html);
    expect(cell).toContain("tier: Smart");
    expect(cell).toContain("Custom review");
    expect(cell).toContain('data-card="Custom review"');
  });

  test("rows without an id render the label without a card", () => {
    const html = renderModel({ resolvedModel: "claude-opus-5-5" });
    expect(html).toContain("Claude Opus 5.5");
    expect(html).not.toContain("data-card");
  });

  test("tasks without any model data render a dash", () => {
    const html = renderModel({ id: "t4" });
    expect(html).not.toContain("data-card");
    expect(html).toContain("—");
  });
});
