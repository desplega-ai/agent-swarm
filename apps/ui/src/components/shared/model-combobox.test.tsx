import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("@/components/shared/provider-icon", () => require("./provider-icon"));
mock.module("@/components/ui/badge", () => require("../ui/badge"));
mock.module("@/components/ui/button", () => require("../ui/button"));
mock.module("@/components/ui/command", () => require("../ui/command"));
mock.module("@/components/ui/dialog", () => require("../ui/dialog"));
mock.module("@/components/ui/popover", () => require("../ui/popover"));
mock.module("@/lib/cost-format", () => require("../../lib/cost-format"));
mock.module("@/lib/utils", () => require("../../lib/utils"));

const { ModelCombobox, formatCacheRates } = await import("./model-combobox");
const { findModelOption, modelGroupsForSchedule } = await import("../../lib/agent-runtime-models");

const groups = modelGroupsForSchedule(null);

function render(value: string) {
  return renderToStaticMarkup(
    <ModelCombobox
      value={value}
      onChange={() => {}}
      groups={groups}
      selected={findModelOption(value, groups)}
      placeholder="Default"
      clearLabel="Default"
      creatable
    />,
  );
}

describe("ModelCombobox", () => {
  // Inside a <form> (the schedule dialogs) a submit-type trigger would submit it.
  test("its trigger never submits an enclosing form", () => {
    expect(render("")).toContain('type="button"');
  });

  test("an empty value shows the placeholder", () => {
    expect(render("")).toContain("Default");
  });

  test("a value the catalog does not list still renders, not blank", () => {
    expect(render("some-custom-model-9")).toContain("some-custom-model-9");
  });

  test("a legacy CLI alias renders as its catalog entry", () => {
    expect(render("opus")).toContain("Opus (");
  });
});

describe("formatCacheRates", () => {
  test("names the rates a model has", () => {
    expect(formatCacheRates({ cache_read: 1.5, cache_write: 6.25 })).toBe(
      "read $1.50 / write $6.25",
    );
    expect(formatCacheRates({ cache_read: 2 })).toBe("read $2.00");
  });

  test("is null for a model without prompt caching", () => {
    expect(formatCacheRates({ input: 1, output: 2 })).toBeNull();
    expect(formatCacheRates(undefined)).toBeNull();
  });
});
