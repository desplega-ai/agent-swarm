import { randomUUID } from "node:crypto";
import { expect, test } from "../fixtures";

for (const mode of ["create", "edit"] as const) {
  test(`the ${mode} schedule form rejects non-object script arguments`, async ({
    api,
    clean,
    page,
    request,
    seed,
    swarm,
  }) => {
    test.skip(!seed, "remote run without seed");
    const name = `e2e-script-args-${randomUUID().slice(0, 8)}`;
    const script = await request.post(`${swarm.apiUrl}/api/scripts/upsert`, {
      headers: { Authorization: `Bearer ${swarm.apiKey}`, "X-Agent-ID": seed!.agents.lead },
      data: {
        name,
        scope: "global",
        source: "export default async function main(args: unknown) { return args; }",
      },
    });
    await expect(script).toBeOK();

    const dialog = page.getByRole("dialog");
    if (mode === "create") {
      await page.goto("/schedules");
      await page.getByRole("button", { name: /^(New schedule|Create Schedule)$/ }).click();
      await dialog.getByPlaceholder("Schedule name").fill(name);
      await dialog.getByRole("button", { name: "Interval", exact: true }).click();
      await dialog.getByRole("button", { name: "Script", exact: true }).click();
      await dialog.getByText("Select a global script", { exact: true }).click();
      await page.getByRole("option", { name }).click();
    } else {
      const schedule = await api.post<{ id: string }>("/api/schedules", {
        name,
        intervalMs: 60 * 60 * 1000,
        targetType: "script",
        scriptName: name,
        enabled: false,
      });
      await page.goto(`/schedules/${schedule.id}`);
      await page.getByRole("button", { name: "Edit", exact: true }).click();
    }

    const args = dialog.getByPlaceholder("{}", { exact: true });
    const submit = dialog.getByRole("button", { name: mode === "create" ? "Create" : "Update" });
    const error = dialog.getByText("Script args must be a JSON object (or left empty).");

    for (const validArgs of ['{"values":[1,null]}', "   "]) {
      await args.fill(validArgs);
      await expect(error).toBeHidden();
      await expect(submit).toBeEnabled();
    }
    for (const nonObject of ["null", '"text"', "1", "false", "[]"]) {
      await args.fill(nonObject);
      await expect(submit).toBeDisabled();
      await expect(error).toBeVisible();
      await expect(args).toHaveAccessibleDescription(
        "Script args must be a JSON object (or left empty).",
      );
    }
    await clean.assertClean();
  });
}
