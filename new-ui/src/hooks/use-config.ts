import { createContext, useCallback, useContext, useState } from "react";
import {
  type Config,
  getConfig,
  getDefaultConfig,
  resetConfig as resetStoredConfig,
  saveConfig,
} from "@/lib/config";

interface ConfigContextValue {
  config: Config;
  setConfig: (config: Config) => void;
  resetConfig: () => void;
  isConfigured: boolean;
}

export const ConfigContext = createContext<ConfigContextValue | null>(null);

function getInitialConfig(): Config {
  const params = new URLSearchParams(window.location.search);
  const apiUrl = params.get("apiUrl");
  const apiKey = params.get("apiKey");

  if (apiUrl || apiKey) {
    const current = getConfig();
    const updated: Config = {
      apiUrl: apiUrl || current.apiUrl,
      apiKey: apiKey || current.apiKey,
    };
    saveConfig(updated);

    // Clean URL params
    const url = new URL(window.location.href);
    url.searchParams.delete("apiUrl");
    url.searchParams.delete("apiKey");
    window.history.replaceState({}, "", url.toString());

    return updated;
  }

  return getConfig();
}

export function useConfigProvider() {
  const [config, setConfigState] = useState<Config>(getInitialConfig);

  const setConfig = useCallback((newConfig: Config) => {
    saveConfig(newConfig);
    setConfigState(newConfig);
  }, []);

  const resetConfig = useCallback(() => {
    resetStoredConfig();
    setConfigState(getDefaultConfig());
  }, []);

  const isConfigured = !!config.apiKey;

  return { config, setConfig, resetConfig, isConfigured };
}

export function useConfig() {
  const context = useContext(ConfigContext);
  if (!context) {
    throw new Error("useConfig must be used within a ConfigProvider");
  }
  return context;
}
