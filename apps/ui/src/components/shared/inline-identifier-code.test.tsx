import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const toastErrors: string[] = [];
mock.module("sonner", () => ({
  toast: { error: (message: string) => toastErrors.push(message) },
}));
mock.module("@/hooks/use-copy-to-clipboard", () => require("../../hooks/use-copy-to-clipboard"));

const { Streamdown } = await import("streamdown");
const { InlineIdentifierCode, isConfigIdentifier } = await import("./inline-identifier-code");

function render(markdown: string): string {
  return renderToStaticMarkup(
    <Streamdown components={{ inlineCode: InlineIdentifierCode }}>{markdown}</Streamdown>,
  );
}

describe("isConfigIdentifier", () => {
  test.each([
    ["BITBUCKET_WEBHOOK_SECRET", true],
    ["GITHUB_TOKEN", true],
    [" GITHUB_TOKEN ", true],
    ["S3_BUCKET_2", true],
    ["API", false],
    ["JSON", false],
    ["fooBar", false],
    ["foo_bar", false],
    ["A", false],
    ["_TOKEN", false],
    ["GITHUB_", false],
    ["BITBUCKET_TOKEN=abc", false],
    ["GITHUB TOKEN", false],
    ["GITHUB_TOKEN and SLACK_BOT_TOKEN", false],
  ])("%p is %p", (text, expected) => {
    expect(isConfigIdentifier(text)).toBe(expected);
  });
});

describe("Streamdown wiring", () => {
  test("an identifier gets a copy button, other inline code does not", () => {
    const html = render("Set `GITHUB_TOKEN` and run `npm i`.");
    expect(html).toContain('aria-label="Copy GITHUB_TOKEN"');
    expect(html).not.toContain("Copy npm i");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  test("a fenced block holding an identifier gets no inline button", () => {
    const html = render("```\nGITHUB_TOKEN\n```");
    expect(html).not.toContain('aria-label="Copy GITHUB_TOKEN"');
  });
});

describe("copy", () => {
  GlobalRegistrator.register();
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  afterAll(async () => {
    await GlobalRegistrator.unregister();
  });

  const written: string[] = [];
  let blocked = false;
  beforeEach(() => {
    written.length = 0;
    toastErrors.length = 0;
    blocked = false;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async (text: string) => {
          if (blocked) throw new Error("denied");
          written.push(text);
        },
      },
    });
  });

  async function clickCopy() {
    const { createRoot } = await import("react-dom/client");
    const host = document.createElement("div");
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => {
      root.render(<InlineIdentifierCode>GITHUB_TOKEN</InlineIdentifierCode>);
    });
    // Nothing is written before the click.
    expect(written).toHaveLength(0);
    const button = host.querySelector("button");
    await act(async () => {
      button?.click();
    });
    const label = button?.getAttribute("aria-label");
    await act(async () => root.unmount());
    host.remove();
    return label;
  }

  test("clicking copies exactly the name", async () => {
    expect(await clickCopy()).toBe("Copied GITHUB_TOKEN");
    expect(written).toEqual(["GITHUB_TOKEN"]);
    expect(toastErrors).toHaveLength(0);
  });

  test("a blocked clipboard toasts", async () => {
    blocked = true;
    expect(await clickCopy()).toBe("Copy GITHUB_TOKEN");
    expect(written).toHaveLength(0);
    expect(toastErrors).toHaveLength(1);
  });
});
