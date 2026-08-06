import type { ReactNode } from "react";
import React, { createContext, useCallback, useContext, useEffect, useState } from "react";
import { DEFAULT_THEME_ID, injectThemePresetStyles, resolveThemeId } from "@/lib/themes";

export type ThemeMode = "dark" | "light" | "system";
type ResolvedTheme = "dark" | "light";

interface ThemeContextValue {
  /** The stored preference — may be `system`. */
  mode: ThemeMode;
  /** What is actually on screen right now. */
  theme: ResolvedTheme;
  /** Dashboard-wide theme preset id (see `@/lib/themes`). */
  preset: string;
  setMode: (mode: ThemeMode) => void;
  setPreset: (preset: string) => void;
  /** Flips the RESOLVED theme and pins it as an explicit mode. */
  toggleTheme: () => void;
}

const MODE_STORAGE_KEY = "agent-swarm-mode";
const PRESET_STORAGE_KEY = "agent-swarm-theme-preset";
const DARK_QUERY = "(prefers-color-scheme: dark)";

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

function getStoredMode(): ThemeMode {
  try {
    const stored = localStorage.getItem(MODE_STORAGE_KEY);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // ignore
  }
  return "dark";
}

function getStoredPreset(): string {
  try {
    return resolveThemeId(localStorage.getItem(PRESET_STORAGE_KEY)) ?? DEFAULT_THEME_ID;
  } catch {
    return DEFAULT_THEME_ID;
  }
}

function systemTheme(): ResolvedTheme {
  try {
    return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

function resolve(mode: ThemeMode): ResolvedTheme {
  return mode === "system" ? systemTheme() : mode;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>(getStoredMode);
  const [preset, setPresetState] = useState<string>(getStoredPreset);
  const [theme, setResolved] = useState<ResolvedTheme>(() => resolve(getStoredMode()));

  // The preset rules exist before anything themed paints — the initializer
  // runs during the first render, ahead of the effects below.
  useState(() => {
    injectThemePresetStyles();
    return null;
  });

  useEffect(() => {
    setResolved(resolve(mode));
    if (mode !== "system") return;
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setResolved(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [mode]);

  useEffect(() => {
    const root = document.documentElement;
    if (theme === "dark") {
      root.classList.add("dark");
    } else {
      root.classList.remove("dark");
    }
  }, [theme]);

  useEffect(() => {
    const root = document.documentElement;
    if (preset === DEFAULT_THEME_ID) {
      root.removeAttribute("data-theme");
    } else {
      root.setAttribute("data-theme", preset);
    }
  }, [preset]);

  const setMode = useCallback((newMode: ThemeMode) => {
    localStorage.setItem(MODE_STORAGE_KEY, newMode);
    setModeState(newMode);
  }, []);

  const setPreset = useCallback((newPreset: string) => {
    const resolved = resolveThemeId(newPreset) ?? DEFAULT_THEME_ID;
    localStorage.setItem(PRESET_STORAGE_KEY, resolved);
    setPresetState(resolved);
  }, []);

  const toggleTheme = useCallback(() => {
    setMode(theme === "dark" ? "light" : "dark");
  }, [theme, setMode]);

  return React.createElement(
    ThemeContext.Provider,
    { value: { mode, theme, preset, setMode, setPreset, toggleTheme } },
    children,
  );
}

export function useTheme(): ThemeContextValue {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useTheme must be used within a ThemeProvider");
  }
  return context;
}
