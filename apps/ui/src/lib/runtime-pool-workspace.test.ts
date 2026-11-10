import { describe, expect, test } from "bun:test";
import { workspaceFormFromPool, workspaceInput, workspaceLabel } from "./runtime-pool-workspace";

describe("runtime pool workspace form", () => {
  test("an untouched form sends no workspace key, whatever is stored", () => {
    for (const workspace of [null, undefined, {}, { sizeGb: 40 }]) {
      const form = workspaceFormFromPool({ workspace });
      expect(form.workspaceTouched).toBe(false);
      for (const kind of ["docker", "k8s", "e2b"] as const)
        expect(workspaceInput(kind, form)).toEqual({ input: {} });
    }
    expect(workspaceInput("docker", workspaceFormFromPool(null))).toEqual({ input: {} });
  });

  test("a touched switch sends null for off and an object for on", () => {
    const stored = workspaceFormFromPool({ workspace: { sizeGb: 40 } });
    expect(stored).toMatchObject({ workspace: true, workspaceSizeGb: "40" });
    const off = { ...stored, workspace: false, workspaceTouched: true };
    expect(workspaceInput("k8s", off).input).toEqual({ workspace: null });
    const on = { ...workspaceFormFromPool(null), workspace: true, workspaceTouched: true };
    expect(workspaceInput("docker", on).input).toEqual({ workspace: {} });
    expect(workspaceInput("k8s", on).input).toEqual({ workspace: {} });
  });

  test("the size is sent for k8s only", () => {
    const form = { workspace: true, workspaceSizeGb: " 50 ", workspaceTouched: true };
    expect(workspaceInput("k8s", form).input).toEqual({ workspace: { sizeGb: 50 } });
    expect(workspaceInput("docker", form).input).toEqual({ workspace: {} });
  });

  test("a kind without support turns a touched workspace off", () => {
    const form = { workspace: true, workspaceSizeGb: "", workspaceTouched: true };
    for (const kind of ["static", "e2b", "boxd"] as const)
      expect(workspaceInput(kind, form).input).toEqual({ workspace: null });
  });

  test("a size outside 1 to 1024 is an error and sends nothing", () => {
    for (const workspaceSizeGb of ["0", "1025", "1.5", "-1", "abc"]) {
      const result = workspaceInput("k8s", {
        workspace: true,
        workspaceSizeGb,
        workspaceTouched: true,
      });
      expect(result.error).toBeDefined();
      expect(result.input).toEqual({});
    }
    // A hidden size field is not validated.
    const hidden = { workspace: true, workspaceSizeGb: "abc", workspaceTouched: true };
    expect(workspaceInput("docker", hidden).error).toBeUndefined();
    expect(workspaceInput("k8s", { ...hidden, workspace: false }).error).toBeUndefined();
  });

  test("the label shows the state and the size when set", () => {
    expect(workspaceLabel(null)).toBe("Off");
    expect(workspaceLabel(undefined)).toBe("Off");
    expect(workspaceLabel({})).toBe("On");
    expect(workspaceLabel({ sizeGb: 40 })).toBe("On, 40 GiB");
  });
});
