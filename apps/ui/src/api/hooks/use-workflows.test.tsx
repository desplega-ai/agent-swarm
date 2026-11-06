import { afterAll, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import type { Workflow } from "../types";

GlobalRegistrator.register();
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterAll(async () => {
  mock.restore();
  await GlobalRegistrator.unregister();
});
const { createRoot } = await import("react-dom/client");
const updateWorkflow = mock(async (): Promise<Workflow> => {
  throw new Error("Update response not configured");
});
mock.module("../client", () => ({ api: { updateWorkflow } }));
const { useUpdateWorkflow } = await import("./use-workflows");

test("saving workflow parameters preserves the cached graph edges", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const workflow = {
    id: "workflow-a",
    params: { answer: "old" },
    definition: { nodes: [], edges: [{ from: "one", to: "two" }] },
  } as unknown as Workflow;
  client.setQueryData(["workflow", workflow.id], workflow);
  updateWorkflow.mockImplementation(
    async () => ({ ...workflow, params: { answer: "new" }, definition: { nodes: [] } }) as Workflow,
  );
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  function Probe() {
    const update = useUpdateWorkflow();
    return (
      <button
        type="button"
        onClick={() => update.mutate({ id: workflow.id, data: { params: { answer: "new" } } })}
      >
        Save
      </button>
    );
  }
  try {
    await act(async () =>
      root.render(
        <QueryClientProvider client={client}>
          <Probe />
        </QueryClientProvider>,
      ),
    );
    await act(async () => {
      container.querySelector("button")?.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const saved = client.getQueryData<Workflow>(["workflow", workflow.id]);
    expect(saved?.params).toEqual({ answer: "new" });
    expect(saved?.definition.edges).toEqual(workflow.definition.edges);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    client.clear();
  }
});
