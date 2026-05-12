// Monaco's defineTheme API requires hex color strings — CSS variables not supported. Light/dark theme objects mirror brand-palette values and stay in sync with globals.css.

export const monacoLightTheme = {
  base: "vs" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "6a737d", fontStyle: "italic" },
    { token: "string", foreground: "032f62" },
    { token: "keyword", foreground: "d73a49" },
    { token: "number", foreground: "005cc5" },
    { token: "type", foreground: "d73a49" },
    { token: "function", foreground: "6f42c1" },
    { token: "variable", foreground: "e36209" },
    { token: "constant", foreground: "005cc5" },
    { token: "operator", foreground: "d73a49" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editor.foreground": "#24292f",
    "editor.lineHighlightBackground": "#f6f8fa",
    "editorLineNumber.foreground": "#6e7781",
    "editorLineNumber.activeForeground": "#24292f",
    "editor.selectionBackground": "#0366d625",
    "editorCursor.foreground": "#24292f",
    "editor.inactiveSelectionBackground": "#0366d610",
  },
};

export const monacoDarkTheme = {
  base: "vs-dark" as const,
  inherit: true,
  rules: [
    { token: "comment", foreground: "8b949e", fontStyle: "italic" },
    { token: "string", foreground: "a5d6ff" },
    { token: "keyword", foreground: "ff7b72" },
    { token: "number", foreground: "79c0ff" },
    { token: "type", foreground: "ffa657" },
    { token: "function", foreground: "d2a8ff" },
    { token: "variable", foreground: "ffa657" },
    { token: "constant", foreground: "79c0ff" },
    { token: "operator", foreground: "ff7b72" },
  ],
  colors: {
    "editor.background": "#0d1117",
    "editor.foreground": "#c9d1d9",
    "editor.lineHighlightBackground": "#161b22",
    "editorLineNumber.foreground": "#6e7681",
    "editorLineNumber.activeForeground": "#c9d1d9",
    "editor.selectionBackground": "#388bfd44",
    "editorCursor.foreground": "#c9d1d9",
    "editor.inactiveSelectionBackground": "#388bfd22",
  },
};
