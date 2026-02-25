import { useCallback, useEffect, useState } from "react";
import {
  getConfig,
  getDefaultConfig,
  resetConfig as resetStoredConfig,
  saveConfig,
  type Config,
} from "@/lib/config";

export function useConfig() {
  const [config, setConfigState] = useState<Config>(getConfig);

  // Parse URL params on mount for auto-connect support
  useEffect(() => {
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
      setConfigState(updated);

      // Clean URL params
      const url = new URL(window.location.href);
      url.searchParams.delete("apiUrl");
      url.searchParams.delete("apiKey");
      window.history.replaceState({}, "", url.toString());
    }
  }, []);

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
