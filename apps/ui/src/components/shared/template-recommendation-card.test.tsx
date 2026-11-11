import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { MemoryRouter, useLocation } from "react-router-dom";
import type { SetupMilestone } from "@/api/types";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const { createRoot } = await import("react-dom/client");

let setup: SetupMilestone[] = [];
mock.module("@/app/status-context", () => ({
  useStatusContext: () => ({ data: { setup } }),
}));
mock.module("@/lib/template-recommendations", () => require("../../lib/template-recommendations"));
mock.module("@/lib/utils", () => require("../../lib/utils"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/card", () => require("../ui/card"));

const { TemplateRecommendationCard } = await import("./template-recommendation-card");
let root: ReturnType<typeof createRoot>;

afterEach(async () => {
  await act(async () => root?.unmount());
  document.body.replaceChildren();
});
afterAll(() => GlobalRegistrator.unregister());

function Location() {
  return <output>{useLocation().pathname}</output>;
}

async function clickRecommendation(actionHref?: string) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root.render(
      <MemoryRouter initialEntries={["/tasks"]}>
        <TemplateRecommendationCard actionHref={actionHref} />
        <Location />
      </MemoryRouter>,
    );
  });
  const button = container.querySelector("button");
  expect(button?.textContent).toContain("Browse templates");
  await act(async () => button?.click());
  return container.querySelector("output")?.textContent;
}

describe("TemplateRecommendationCard navigation", () => {
  test.each([
    { integrations: ["slack", "github"], templateId: "pr-triage" },
    { integrations: ["linear", "github"], templateId: "issue-to-pr" },
    { integrations: ["jira"], templateId: "bug-intake" },
    { integrations: [], templateId: "hello-world" },
  ] satisfies {
    integrations: SetupMilestone["id"][];
    templateId: string;
  }[])("opens the recommended $templateId detail page by default", async ({
    integrations,
    templateId,
  }) => {
    setup = integrations.map((id) => ({ id, label: id, state: "configured" }));
    expect(await clickRecommendation()).toBe(`/templates/${templateId}`);
  });

  test("an explicit actionHref takes precedence over the recommendation", async () => {
    setup = [
      { id: "slack", label: "Slack", state: "configured" },
      { id: "github", label: "GitHub", state: "verified" },
    ];
    expect(await clickRecommendation("/templates")).toBe("/templates");
  });
});
