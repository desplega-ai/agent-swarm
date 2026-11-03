import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  importThemeTokens,
  THEME_IMPORT_FORMATS,
  ThemeImportError,
  type ThemeImportInput,
} from "../themes/import";
import { HIVE_PAGE_TOKENS, PAGE_THEME_COLOR_TOKENS } from "../themes/tokens";
import { PageThemeTokensInputSchema } from "../types";

const PRIMARY = "oklch(0.5 0.2 30)";

/** The error that importing `input` throws (fails the test when nothing is thrown). */
function importError(input: ThemeImportInput): ThemeImportError {
  try {
    importThemeTokens(input);
  } catch (error) {
    if (error instanceof ThemeImportError) return error;
    throw error;
  }
  throw new Error("expected importThemeTokens to throw");
}

/** Raw JSON input, the way an HTTP body or a tool call delivers it (any shape). */
function rawInput(json: string): ThemeImportInput {
  return JSON.parse(json);
}

function lightTokens(light: Record<string, string>) {
  return importThemeTokens({ light }).tokens.light;
}

describe("importThemeTokens: tokens format names", () => {
  test("--color-primary, --primary, primary and color-primary all name --color-primary", () => {
    for (const name of ["--color-primary", "--primary", "primary", "color-primary"]) {
      expect(lightTokens({ [name]: PRIMARY })).toEqual({ "--color-primary": PRIMARY });
    }
  });

  test("font and radius names map the same way", () => {
    expect(
      lightTokens({
        "font-sans": "Inter, sans-serif",
        "--font-mono": "monospace",
        "radius-sm": "2px",
        "--radius-xl": "16px",
      }),
    ).toEqual({
      "--font-sans": "Inter, sans-serif",
      "--font-mono": "monospace",
      "--radius-sm": "2px",
      "--radius-xl": "16px",
    });
  });

  test("multi-word color names map too", () => {
    expect(
      lightTokens({
        "card-foreground": "white",
        "border-subtle": "gray",
        "chart-3": "blue",
        "status-success-strong": "green",
      }),
    ).toEqual({
      "--color-card-foreground": "white",
      "--color-border-subtle": "gray",
      "--color-chart-3": "blue",
      "--color-status-success-strong": "green",
    });
  });

  test("shadcn --radius expands to the four radius tokens", () => {
    const expected = {
      "--radius-sm": "calc(0.5rem - 4px)",
      "--radius-md": "calc(0.5rem - 2px)",
      "--radius-lg": "0.5rem",
      "--radius-xl": "calc(0.5rem + 4px)",
    };
    expect(lightTokens({ "--radius": "0.5rem" })).toEqual(expected);
    expect(lightTokens({ radius: "0.5rem" })).toEqual(expected);
  });

  test("an explicit radius token wins over the --radius expansion in either order", () => {
    expect(lightTokens({ "--radius-lg": "1rem", "--radius": "0.5rem" })["--radius-lg"]).toBe(
      "1rem",
    );
    expect(lightTokens({ "--radius": "0.5rem", "--radius-lg": "1rem" })["--radius-lg"]).toBe(
      "1rem",
    );
  });

  test("bare HSL triplets are wrapped as hsl(...), other values stay as they are", () => {
    expect(
      lightTokens({
        primary: "222.2 47.4% 11.2%",
        background: "0 0% 100%",
        ring: "0 0% 0% / 0.5",
        card: "oklch(1 0 0)",
        border: "#e5e7eb",
        "font-sans": '"Inter", sans-serif',
      }),
    ).toEqual({
      "--color-primary": "hsl(222.2 47.4% 11.2%)",
      "--color-background": "hsl(0 0% 100%)",
      "--color-ring": "hsl(0 0% 0% / 0.5)",
      "--color-card": "oklch(1 0 0)",
      "--color-border": "#e5e7eb",
      "--font-sans": '"Inter", sans-serif',
    });
  });

  test("values are trimmed and !important is dropped", () => {
    expect(lightTokens({ primary: `  ${PRIMARY} !important ` })).toEqual({
      "--color-primary": PRIMARY,
    });
    expect(lightTokens({ ring: "red ! IMPORTANT", card: "blue!important" })).toEqual({
      "--color-ring": "red",
      "--color-card": "blue",
    });
  });

  test("names outside the contract go to ignored and never throw", () => {
    const result = importThemeTokens({
      light: {
        "--sidebar": "url(https://example.com/x.png)",
        "--shadow-2xs": "0 1px 2px x; y",
        "--tracking-normal": "0.025em",
        "--spacing": "0.25rem",
        "--font-serif": "Georgia, serif",
        primary: PRIMARY,
      },
      dark: { "--sidebar": "black", "--color-sidebar-ring": "red" },
    });
    expect(result.tokens).toEqual({ light: { "--color-primary": PRIMARY }, dark: {} });
    expect(result.ignored).toEqual([
      "--sidebar",
      "--shadow-2xs",
      "--tracking-normal",
      "--spacing",
      "--font-serif",
      "--color-sidebar-ring",
    ]);
  });

  test("light and dark stay separate, and the format defaults to tokens", () => {
    const input = { light: { primary: PRIMARY }, dark: { primary: "oklch(0.7 0.15 30)" } };
    const expected = {
      tokens: {
        light: { "--color-primary": PRIMARY },
        dark: { "--color-primary": "oklch(0.7 0.15 30)" },
      },
      ignored: [],
    };
    expect(importThemeTokens(input)).toEqual(expected);
    expect(importThemeTokens({ format: "tokens", ...input })).toEqual(expected);
    expect(importThemeTokens({})).toEqual({ tokens: { light: {}, dark: {} }, ignored: [] });
    expect(importThemeTokens(rawInput('{"light":null,"dark":{"ring":"red"}}')).tokens).toEqual({
      light: {},
      dark: { "--color-ring": "red" },
    });
  });

  test("normalized output imports back to itself", () => {
    const first = importThemeTokens({
      light: { "--radius": "0.5rem", primary: "222.2 47.4% 11.2%", ring: "var(--primary)" },
      dark: { primary: "oklch(0.7 0.15 30)" },
    });
    expect(importThemeTokens(first.tokens)).toEqual({ tokens: first.tokens, ignored: [] });
  });
});

describe("importThemeTokens: var() references", () => {
  test("references are renamed to contract names", () => {
    expect(
      lightTokens({
        ring: "var(--primary)",
        "chart-2": "var(--color-chart-1)",
        "--radius-sm": "calc(var(--radius) - 2px)",
        accent: "color-mix(in oklab, var( --primary ) 20%, transparent)",
      }),
    ).toEqual({
      "--color-ring": "var(--color-primary)",
      "--color-chart-2": "var(--color-chart-1)",
      "--radius-sm": "calc(var(--radius-lg) - 2px)",
      "--color-accent": "color-mix(in oklab, var(--color-primary ) 20%, transparent)",
    });
  });

  test("a declaration that references its own token is dropped without a report", () => {
    const result = importThemeTokens({
      light: { "--color-primary": "var(--primary)", "--radius-lg": "var(--radius)" },
    });
    expect(result).toEqual({ tokens: { light: {}, dark: {} }, ignored: [] });
  });

  test("a reference outside the contract sends its declaration to ignored, with the reference", () => {
    const result = importThemeTokens({
      light: {
        primary: "var(--brand)",
        "--font-sans": "var(--font-geist-sans)",
        card: "var(--swarm-card)",
        ring: "var(--primary)",
        accent: "color-mix(in oklab, var(--brand) 50%, var(--accent2), var(--brand))",
      },
    });
    expect(result.tokens.light).toEqual({ "--color-ring": "var(--color-primary)" });
    expect(result.ignored).toEqual([
      "primary (references --brand)",
      "--font-sans (references --font-geist-sans)",
      "card (references --swarm-card)",
      "accent (references --brand, --accent2)",
    ]);
  });
});

describe("importThemeTokens: css format", () => {
  test("reads :root as light and .dark as dark", () => {
    const result = importThemeTokens({
      format: "css",
      css: `:root { --primary: ${PRIMARY}; --radius: 0.5rem }\n.dark { --primary: oklch(0.7 0.15 30); }`,
    });
    expect(result).toEqual({
      tokens: {
        light: {
          "--color-primary": PRIMARY,
          "--radius-sm": "calc(0.5rem - 4px)",
          "--radius-md": "calc(0.5rem - 2px)",
          "--radius-lg": "0.5rem",
          "--radius-xl": "calc(0.5rem + 4px)",
        },
        dark: { "--color-primary": "oklch(0.7 0.15 30)" },
      },
      ignored: [],
    });
  });

  test("reads a Tailwind v4 @theme block as light", () => {
    const result = importThemeTokens({
      format: "css",
      css: `@import "tailwindcss";
@theme {
  --color-*: initial;
  --color-primary: oklch(0.6 0.2 250);
  --font-sans: "Inter", ui-sans-serif, system-ui, sans-serif;
  --breakpoint-3xl: 120rem;
}`,
    });
    expect(result).toEqual({
      tokens: {
        light: {
          "--color-primary": "oklch(0.6 0.2 250)",
          "--font-sans": '"Inter", ui-sans-serif, system-ui, sans-serif',
        },
        dark: {},
      },
      ignored: ["--color-*", "--breakpoint-3xl"],
    });
  });

  test("a shadcn (Tailwind v4) globals.css keeps the :root and .dark values, not the @theme inline plumbing", () => {
    const result = importThemeTokens({
      format: "css",
      css: `@import "tailwindcss";
@import "tw-animate-css";

@custom-variant dark (&:is(.dark *));

@theme inline {
  --color-background: var(--background);
  --color-foreground: var(--foreground);
  --font-sans: var(--font-geist-sans);
  --color-primary: var(--primary);
  --color-ring: var(--ring);
  --color-sidebar-ring: var(--sidebar-ring);
  --radius-sm: calc(var(--radius) - 4px);
  --radius-md: calc(var(--radius) - 2px);
  --radius-lg: var(--radius);
  --radius-xl: calc(var(--radius) + 4px);
}

:root {
  --radius: 0.625rem;
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0 0);
  --primary: oklch(0.205 0 0);
  --ring: oklch(0.708 0 0);
  --sidebar-ring: oklch(0.708 0 0);
}

.dark {
  --background: oklch(0.145 0 0);
  --foreground: oklch(0.985 0 0);
  --primary: oklch(0.922 0 0);
  --ring: oklch(0.556 0 0);
}

@layer base {
  * {
    @apply border-border outline-ring/50;
  }
  body {
    @apply bg-background text-foreground;
  }
}`,
    });
    expect(result).toEqual({
      tokens: {
        light: {
          "--color-background": "oklch(1 0 0)",
          "--color-foreground": "oklch(0.145 0 0)",
          "--color-primary": "oklch(0.205 0 0)",
          "--color-ring": "oklch(0.708 0 0)",
          "--radius-sm": "calc(var(--radius-lg) - 4px)",
          "--radius-md": "calc(var(--radius-lg) - 2px)",
          "--radius-lg": "0.625rem",
          "--radius-xl": "calc(var(--radius-lg) + 4px)",
        },
        dark: {
          "--color-background": "oklch(0.145 0 0)",
          "--color-foreground": "oklch(0.985 0 0)",
          "--color-primary": "oklch(0.922 0 0)",
          "--color-ring": "oklch(0.556 0 0)",
        },
      },
      ignored: [
        "--font-sans (references --font-geist-sans)",
        "--color-sidebar-ring",
        "--sidebar-ring",
      ],
    });
  });

  test("a tweakcn export keeps colors, fonts and radius, and ignores shadows and tracking", () => {
    const result = importThemeTokens({
      format: "css",
      css: `:root {
  --background: oklch(0.9911 0 0);
  --primary: oklch(0.4365 0.1044 156.7556);
  --sidebar: oklch(0.9911 0 0);
  --font-sans: Outfit, sans-serif;
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono: monospace;
  --radius: 0.5rem;
  --shadow-2xs: 0px 1px 3px 0px hsl(0 0% 0% / 0.09);
  --tracking-normal: 0.025em;
  --spacing: 0.25rem;
}

.dark {
  --background: oklch(0.1822 0 0);
  --primary: oklch(0.4365 0.1044 156.7556);
  --font-sans: Outfit, sans-serif;
}

@theme inline {
  --color-background: var(--background);
  --color-primary: var(--primary);
  --color-sidebar: var(--sidebar);
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);
  --radius-lg: var(--radius);
  --shadow-2xs: var(--shadow-2xs);
  --tracking-tighter: calc(var(--tracking-normal) - 0.05em);
}

body {
  letter-spacing: var(--tracking-normal);
}`,
    });
    expect(result).toEqual({
      tokens: {
        light: {
          "--color-background": "oklch(0.9911 0 0)",
          "--color-primary": "oklch(0.4365 0.1044 156.7556)",
          "--font-sans": "Outfit, sans-serif",
          "--font-mono": "monospace",
          "--radius-sm": "calc(0.5rem - 4px)",
          "--radius-md": "calc(0.5rem - 2px)",
          "--radius-lg": "0.5rem",
          "--radius-xl": "calc(0.5rem + 4px)",
        },
        dark: {
          "--color-background": "oklch(0.1822 0 0)",
          "--color-primary": "oklch(0.4365 0.1044 156.7556)",
          "--font-sans": "Outfit, sans-serif",
        },
      },
      ignored: [
        "--sidebar",
        "--font-serif",
        "--shadow-2xs",
        "--tracking-normal",
        "--spacing",
        "--color-sidebar",
        "--tracking-tighter",
      ],
    });
  });

  test("a shadcn (Tailwind v3) paste inside @layer base wraps its HSL triplets", () => {
    const result = importThemeTokens({
      format: "css",
      css: `@tailwind base;
@tailwind components;

@layer base {
  :root {
    --background: 0 0% 100%;
    --primary: 222.2 47.4% 11.2%;
    --radius: 0.5rem;
  }

  .dark {
    --background: 222.2 84% 4.9%;
    --primary: 210 40% 98%;
  }
}

@layer base {
  body {
    @apply bg-background text-foreground;
  }
}`,
    });
    expect(result.tokens).toEqual({
      light: {
        "--color-background": "hsl(0 0% 100%)",
        "--color-primary": "hsl(222.2 47.4% 11.2%)",
        "--radius-sm": "calc(0.5rem - 4px)",
        "--radius-md": "calc(0.5rem - 2px)",
        "--radius-lg": "0.5rem",
        "--radius-xl": "calc(0.5rem + 4px)",
      },
      dark: {
        "--color-background": "hsl(222.2 84% 4.9%)",
        "--color-primary": "hsl(210 40% 98%)",
      },
    });
    expect(result.ignored).toEqual([]);
  });

  test("skips comments and plain properties, and reports the custom properties of other blocks and nested rules", () => {
    const result = importThemeTokens({
      format: "css",
      css: `/* :root { --primary: red; } */
body { --primary: red; content: "} { ;"; }
.card:is(.a, .b) { --ring: red; }
:root {
  /* the brand */
  --primary: ${PRIMARY}; /* trailing */
  color: black;
  --font-sans:
    "Inter",
    sans-serif;
  & .nested { --ring: red; }
  --ring: var(--primary)
}`,
    });
    expect(result).toEqual({
      tokens: {
        light: {
          "--color-primary": PRIMARY,
          "--font-sans": '"Inter", sans-serif',
          "--color-ring": "var(--color-primary)",
        },
        dark: {},
      },
      ignored: ["--primary (in body)", "--ring (in .card:is(.a, .b))", "--ring (in & .nested)"],
    });
  });

  test("reads compiled Tailwind v4 output: :root, :host is light, and @supports rules are reported", () => {
    const result = importThemeTokens({
      format: "css",
      css: `/*! tailwindcss v4.1.0 | MIT License | https://tailwindcss.com */
@layer properties {
  @supports ((-webkit-hyphens: none) and (not (margin-trim: inline))) {
    *, :before, :after, ::backdrop { --tw-border-style: solid; }
  }
}
@layer theme {
  :root, :host {
    --font-sans: ui-sans-serif, system-ui, sans-serif;
    --color-red-500: oklch(63.7% 0.237 25.331);
    --radius-lg: 0.5rem;
    --default-font-family: var(--font-sans);
  }
}
@layer base {
  *, ::after, ::before { box-sizing: border-box; border: 0 solid; }
}`,
    });
    expect(result).toEqual({
      tokens: {
        light: { "--font-sans": "ui-sans-serif, system-ui, sans-serif", "--radius-lg": "0.5rem" },
        dark: {},
      },
      ignored: [
        "--color-red-500",
        "--default-font-family",
        "--tw-border-style (in @supports ((-webkit-hyphens: none) and (...)",
      ],
    });
  });

  test("reads every part of a selector list: .dark, [data-theme=dark] is dark", () => {
    const result = importThemeTokens({
      format: "css",
      css: `:root { --primary: ${PRIMARY}; }
.dark, [data-theme=dark] { --primary: oklch(0.7 0.15 30); }`,
    });
    expect(result).toEqual({
      tokens: {
        light: { "--color-primary": PRIMARY },
        dark: { "--color-primary": "oklch(0.7 0.15 30)" },
      },
      ignored: [],
    });
  });

  test("names each light and dark selector form", () => {
    const light = [":root", ":host", "html", ":root, :host", "@theme", "@theme inline"];
    const dark = [
      ".dark",
      ":root.dark",
      "html.dark",
      "[data-theme=dark]",
      '[data-theme="dark"]',
      "[data-theme='dark']",
      ".dark, [data-theme=dark]",
    ];
    for (const selector of light) {
      expect(
        importThemeTokens({ format: "css", css: `${selector} { --ring: red; }` }).tokens,
      ).toEqual({ light: { "--color-ring": "red" }, dark: {} });
    }
    for (const selector of dark) {
      expect(
        importThemeTokens({ format: "css", css: `${selector} { --ring: red; }` }).tokens,
      ).toEqual({ light: {}, dark: { "--color-ring": "red" } });
    }
  });

  test("a list with a light and a dark part feeds both modes", () => {
    expect(
      importThemeTokens({ format: "css", css: ":root, .dark { --font-sans: Inter; }" }).tokens,
    ).toEqual({ light: { "--font-sans": "Inter" }, dark: { "--font-sans": "Inter" } });
  });

  test("reads :root inside @media (prefers-color-scheme: dark) as dark", () => {
    const result = importThemeTokens({
      format: "css",
      css: `:root { --primary: ${PRIMARY}; }
@media (prefers-color-scheme: dark) {
  :root { --primary: oklch(0.7 0.15 30); }
  @layer base { :host { --ring: blue; } }
}
@media(prefers-color-scheme:dark) { :root { --card: black; } }`,
    });
    expect(result).toEqual({
      tokens: {
        light: { "--color-primary": PRIMARY },
        dark: {
          "--color-primary": "oklch(0.7 0.15 30)",
          "--color-ring": "blue",
          "--color-card": "black",
        },
      },
      ignored: [],
    });
  });

  test("reports the custom properties of other media queries, other selectors and @theme inside a media query", () => {
    const result = importThemeTokens({
      format: "css",
      css: `:root { --primary: ${PRIMARY}; }
@media print { :root { --primary: black; } }
@media (prefers-color-scheme: light) { :root { --ring: red; } }
:root:not(.dark), .light { --card: white; color: black; }
@media (prefers-color-scheme: dark) { @theme { --color-ring: red; } }
.a-very-long-selector-name-that-goes-on-and-on > .child { --accent: red; }`,
    });
    expect(result.tokens).toEqual({ light: { "--color-primary": PRIMARY }, dark: {} });
    expect(result.ignored).toEqual([
      "--primary (in @media print)",
      "--ring (in @media (prefers-color-scheme: light))",
      "--card (in :root:not(.dark), .light)",
      "--color-ring (in @theme)",
      "--accent (in .a-very-long-selector-name-that-goes-on-...)",
    ]);
  });

  test("throws only when no block is a light or dark block", () => {
    expect(
      importError({ format: "css", css: "body { --primary: red; } .card { --ring: red; }" })
        .message,
    ).toBe("themeTokens.css has no :root, .dark, or @theme block");
    expect(importThemeTokens({ format: "css", css: "body { --primary: red; } :host { }" })).toEqual(
      { tokens: { light: {}, dark: {} }, ignored: ["--primary (in body)"] },
    );
  });

  test("checks css values like token values", () => {
    expect(
      importError({ format: "css", css: ":root { --primary: url(x.png); }" }).message,
    ).toContain('"--primary"');
  });

  test("the dashboard's own globals.css imports to the Hive tokens", async () => {
    const css = await Bun.file(
      join(import.meta.dir, "../../apps/ui/src/styles/globals.css"),
    ).text();
    const { tokens } = importThemeTokens({ format: "css", css });
    expect(tokens.light).toEqual(HIVE_PAGE_TOKENS.light);
    expect(tokens.dark).toEqual(
      Object.fromEntries(
        PAGE_THEME_COLOR_TOKENS.map((token) => [token, HIVE_PAGE_TOKENS.dark[token]]),
      ),
    );
  });
});

describe("importThemeTokens: unsafe values", () => {
  test("rejects external image functions in token maps and CSS blocks", () => {
    for (const value of [
      'image-set("https://example.com/track.png" 1x)',
      'IMAGE-SET("https://example.com/track.png" 1x)',
      '-webkit-image-set("https://example.com/track.png" 1x)',
      'image("https://example.com/track.png")',
      'src("https://example.com/track.png")',
      'cross-fade(image-set("https://example.com/track.png" 1x), red, 50%)',
    ]) {
      for (const input of [
        { light: { "--color-surface": value } },
        { format: "css" as const, css: `:root { --color-surface: ${value}; }` },
      ]) {
        expect(importError(input).message).toContain("value must not contain");
      }
    }
  });

  const unsafe = [
    "red; color: blue",
    "red{",
    "red}",
    "<b>",
    "a > b",
    "\\72 ed",
    "red\nblue",
    "red\tblue",
    "url(https://example.com/x.png)",
    "URL(x)",
    "expression(alert(1))",
    "@import 'x.css'",
    "javascript:alert(1)",
    "red /* note",
    "",
    "   ",
    "x".repeat(201),
    "oklch(0.5 0.2 30",
    "oklch(0.5 0.2 30))",
    '"Inter, sans-serif',
  ];

  for (const value of unsafe) {
    test(`throws for ${JSON.stringify(value.slice(0, 40))}`, () => {
      const error = importError({ light: { primary: value } });
      expect(error.name).toBe("ThemeImportError");
      expect(error.message).toContain('"primary"');
    });
  }

  test("accepts a value of exactly 200 characters, also with a trailing !important", () => {
    expect(lightTokens({ primary: "x".repeat(200) })["--color-primary"]).toHaveLength(200);
    expect(
      lightTokens({ primary: `${"x".repeat(200)} !important` })["--color-primary"],
    ).toHaveLength(200);
  });

  test("a huge value fails on its length in linear time", () => {
    // The old `!important` strip ran a regex that cost about 2.2 s on 100k spaces.
    const started = performance.now();
    for (const value of [
      `x${" ".repeat(100_000)}x`,
      `red${" ".repeat(100_000)}!important`,
      `red !${" ".repeat(100_000)}important`,
    ]) {
      expect(importError({ light: { primary: value } }).message).toBe(
        'light token "primary": value must be 1 to 200 characters',
      );
    }
    expect(performance.now() - started).toBeLessThan(100);
  });

  test("names the mode in the message", () => {
    expect(importError({ dark: { ring: "url(x)" } }).message).toBe(
      'dark token "ring": value must not contain "url("',
    );
  });
});

describe("importThemeTokens: bad shapes", () => {
  test("lists the known formats", () => {
    expect(THEME_IMPORT_FORMATS).toEqual(["tokens", "css"]);
  });

  test("the page input schema takes exactly the importer's formats", () => {
    expect(PageThemeTokensInputSchema.shape.format.unwrap().options).toEqual([
      ...THEME_IMPORT_FORMATS,
    ]);
  });

  test("a field set to undefined counts as absent", () => {
    const css = {
      format: "css" as const,
      css: `:root { --primary: ${PRIMARY} }`,
      light: undefined,
    };
    expect(importThemeTokens(css).tokens.light).toEqual({ "--color-primary": PRIMARY });
    const tokens = { light: { primary: PRIMARY }, dark: undefined, css: undefined };
    expect(importThemeTokens(tokens).tokens).toEqual({
      light: { "--color-primary": PRIMARY },
      dark: {},
    });
  });

  test("an unknown format throws", () => {
    expect(importError(rawInput('{"format":"dtcg"}')).message).toBe(
      'unknown themeTokens format "dtcg": use one of tokens, css',
    );
    expect(importError(rawInput('{"format":3}')).message).toContain("unknown themeTokens format");
  });

  const shapes: Array<[string, string]> = [
    ["null", "themeTokens must be an object"],
    ["[]", "themeTokens must be an object"],
    ['"primary"', "themeTokens must be an object"],
    ['{"light":[]}', "themeTokens.light must be an object"],
    ['{"dark":"red"}', "themeTokens.dark must be an object"],
    ['{"light":{"primary":3}}', 'themeTokens.light["primary"] must be a string'],
    ['{"primary":"red"}', 'unknown themeTokens field "primary"'],
    ['{"css":":root{}"}', 'unknown themeTokens field "css" for format "tokens"'],
    ['{"format":"css"}', "themeTokens.css must be a string"],
    ['{"format":"css","css":3}', "themeTokens.css must be a string"],
    ['{"format":"css","css":":root{}","light":{}}', 'unknown themeTokens field "light"'],
    ['{"format":"css","css":"body { color: red; }"}', "no :root, .dark, or @theme block"],
    ['{"format":"css","css":":root { --primary: red"}', 'unclosed "{"'],
    ['{"format":"css","css":":root { } }"}', 'unmatched "}"'],
  ];

  for (const [json, message] of shapes) {
    test(`throws for ${json}`, () => {
      expect(importError(rawInput(json)).message).toContain(message);
    });
  }
});
