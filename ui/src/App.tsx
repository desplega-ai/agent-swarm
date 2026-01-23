import Box from "@mui/joy/Box";
import { useEffect, useState } from "react";
import ConfigModal from "./components/ConfigModal";
import Dashboard from "./components/Dashboard";
import { getConfig, saveConfig } from "./lib/config";

export default function App() {
  const [configOpen, setConfigOpen] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  useEffect(() => {
    // Check for query params to auto-configure
    const params = new URLSearchParams(window.location.search);
    const urlApiUrl = params.get("apiUrl");
    const urlApiKey = params.get("apiKey");

    if (urlApiUrl || urlApiKey) {
      const currentConfig = getConfig();
      const newConfig = {
        apiUrl: urlApiUrl || currentConfig.apiUrl,
        apiKey: urlApiKey ?? currentConfig.apiKey,
      };
      saveConfig(newConfig);

      // Remove query params from URL
      params.delete("apiUrl");
      params.delete("apiKey");
      const newUrl = params.toString()
        ? `${window.location.pathname}?${params.toString()}`
        : window.location.pathname;
      window.history.replaceState({}, "", newUrl);
    }

    const config = getConfig();
    if (!config.apiUrl) {
      setConfigOpen(true);
    } else {
      setIsConfigured(true);
    }
  }, []);

  const handleConfigSave = () => {
    setConfigOpen(false);
    setIsConfigured(true);
  };

  return (
    <Box
      sx={{
        minHeight: "100vh",
        bgcolor: "background.body",
      }}
    >
      <ConfigModal
        open={configOpen || !isConfigured}
        onClose={() => isConfigured && setConfigOpen(false)}
        onSave={handleConfigSave}
        blocking={!isConfigured}
      />
      {isConfigured && <Dashboard onSettingsClick={() => setConfigOpen(true)} />}
    </Box>
  );
}
