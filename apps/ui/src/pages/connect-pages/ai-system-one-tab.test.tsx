import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  button,
  calls,
  click,
  configRow,
  installAiTabDom,
  json,
  mount,
  presenceRoute,
  press,
  routes,
  settle,
  text,
} from "./ai-tabs-test-dom";

await installAiTabDom({ mock, beforeEach, afterEach, afterAll });

const { SystemOneTab, systemOneDefault } = await import("./ai-system-one-tab");
const { findAiProvider } = await import("../../lib/ai-providers");

function serve(rows: ReturnType<typeof configRow>[], present: string[] = []) {
  routes["GET /api/config"] = () => json({ configs: rows });
  routes["GET /api/config/env-presence"] = presenceRoute(present);
  routes["PUT /api/config"] = (_url, init) => json(JSON.parse(String(init?.body)));
}

function rowOf(name: string): HTMLElement {
  const row = Array.from(document.body.querySelectorAll("li")).find((li) =>
    li.textContent?.includes(name),
  );
  if (!row) throw new Error(`no row "${name}" in: ${text()}`);
  return row;
}

describe("System One tab", () => {
  test("rows show what each host serves and whether its keys are set", async () => {
    serve(
      [
        configRow("TYPESAFE_API_KEY", "********", true),
        configRow("CLOUDFLARE_API_TOKEN", "********", true),
      ],
      ["OPENROUTER_API_KEY"],
    );
    const view = await mount(<SystemOneTab search="" onSetUp={() => {}} />);
    await settle();

    expect(text()).toContain("Fast typed decisions and extraction in workflows and gates.");
    expect(rowOf("Jev via TypeSafe").textContent).toContain("Configured");
    // OpenRouter's key is the LLM pool: the server reads it from its environment.
    expect(rowOf("Jev via OpenRouter").textContent).toContain("Configured");
    const cloudflare = rowOf("Clef via Cloudflare").textContent ?? "";
    expect(cloudflare).toContain("Incomplete");
    expect(cloudflare).toContain("Needs CLOUDFLARE_ACCOUNT_ID");
    expect(cloudflare).toContain("clef, clef-flash · clairic");
    expect(rowOf("laya").textContent).toContain("Not set");
    expect(rowOf("laya").textContent).toContain("Picked from the text");
    await view.cleanup();
  });

  test("the decide selector writes SYSTEM_ONE_DEFAULT_PROVIDER", async () => {
    serve([configRow("SYSTEM_ONE_EXTRACT_DEFAULT_PROVIDER", "cloudflare")]);
    const view = await mount(<SystemOneTab search="" onSetUp={() => {}} />);
    await settle();

    const decide = document.body.querySelector('[role="combobox"]') as HTMLElement;
    expect(decide.textContent).toContain("Jev via TypeSafe");
    const extract = document.body.querySelectorAll('[role="combobox"]')[1] as HTMLElement;
    expect(extract.textContent).toContain("Clairic via Cloudflare");

    await press(decide, "Enter");
    await settle(2);
    const option = Array.from(document.body.querySelectorAll('[role="option"]')).find(
      (el) => el.textContent === "Clef via Cloudflare",
    ) as HTMLElement | undefined;
    if (!option) throw new Error(`no Clef option in: ${text()}`);
    await press(option, "Enter");
    await settle();

    const writes = calls.filter((c) => c.method === "PUT" && c.path === "/api/config");
    expect(writes.map((c) => c.body)).toEqual([
      expect.objectContaining({
        scope: "global",
        key: "SYSTEM_ONE_DEFAULT_PROVIDER",
        value: "cloudflare",
        isSecret: false,
      }),
    ]);
    await view.cleanup();
  });

  test("Set up opens the host's panel; OpenRouter opens the LLMs panel", async () => {
    serve([]);
    const opened: string[] = [];
    const view = await mount(<SystemOneTab search="" onSetUp={(id) => opened.push(id)} />);
    await settle();

    await click(button("Set up laya"));
    await click(button("Set up Jev via OpenRouter"));
    expect(opened).toEqual(["system-one-laya", "openrouter"]);
    expect(findAiProvider("system-one-laya")?.fields.map((f) => [f.key, f.kind])).toEqual([
      ["LAYA_URL", "text"],
      ["LAYA_API_KEY", "secret"],
    ]);
    await view.cleanup();
  });

  test("a search keeps the matching hosts", async () => {
    serve([]);
    const view = await mount(<SystemOneTab search="clairic" onSetUp={() => {}} />);
    await settle();
    expect(document.body.querySelectorAll('ul[aria-label="System One hosts"] > li').length).toBe(1);
    expect(text()).toContain("Clef via Cloudflare");
    await view.cleanup();
  });

  test("an unknown stored default falls back like the server", () => {
    expect(
      systemOneDefault([configRow("SYSTEM_ONE_DEFAULT_PROVIDER", "jev")] as never, "decide"),
    ).toEqual({ id: "typesafe", stored: false });
    expect(
      systemOneDefault([configRow("SYSTEM_ONE_DEFAULT_PROVIDER", " Laya ")] as never, "decide"),
    ).toEqual({ id: "laya", stored: true });
    expect(systemOneDefault([], "extract")).toEqual({ id: "cloudflare", stored: false });
  });
});
