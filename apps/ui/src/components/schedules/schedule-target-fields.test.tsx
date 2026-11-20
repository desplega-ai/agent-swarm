import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { within } from "@testing-library/dom";
import userEvent from "@testing-library/user-event";
import { act, useState } from "react";

GlobalRegistrator.register();
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const { createRoot } = await import("react-dom/client");

// The root Bun test runner cannot resolve the dashboard's @/ alias.
mock.module("@/api/hooks/use-scripts", () => require("../../api/hooks/use-scripts"));
mock.module("@/api/hooks/use-workflows", () => require("../../api/hooks/use-workflows"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/label", () => require("../ui/label"));
mock.module("@/components/ui/select", () => require("../ui/select"));
mock.module("@/components/ui/textarea", () => require("../ui/textarea"));
mock.module("@/lib/config", () => require("../../lib/config"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { EMPTY_SCHEDULE_TARGET, ScheduleTargetFields } = await import("./schedule-target-fields");

afterAll(async () => GlobalRegistrator.unregister());

function Form() {
  const [value, setValue] = useState(EMPTY_SCHEDULE_TARGET);
  return <ScheduleTargetFields value={value} onChange={setValue} />;
}

test("exposes exactly one pressed execution type as mouse and keyboard selection change", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { enabled: false } } });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const user = userEvent.setup({ document });
  const buttons = within(container);
  const labelsWithPressedState = (pressed: boolean) =>
    buttons.queryAllByRole("button", { pressed }).map((button) => button.textContent);

  try {
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <Form />
        </QueryClientProvider>,
      );
    });
    expect(labelsWithPressedState(true)).toEqual(["Agent Task"]);

    await act(async () => user.click(buttons.getByRole("button", { name: "Script" })));
    expect(labelsWithPressedState(true)).toEqual(["Script"]);
    expect(labelsWithPressedState(false)).toEqual(["Agent Task", "Workflow"]);

    await act(async () => {
      await user.tab({ shift: true });
      await user.keyboard("{Enter}");
    });
    expect(labelsWithPressedState(true)).toEqual(["Workflow"]);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
