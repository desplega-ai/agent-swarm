import { useState, useEffect } from "react";
import Box from "@mui/joy/Box";
import { getConfig } from "./lib/config";
import ConfigModal from "./components/ConfigModal";
import Dashboard from "./components/Dashboard";

export default function App() {
  const [configOpen, setConfigOpen] = useState(false);
  const [isConfigured, setIsConfigured] = useState(false);

  useEffect(() => {
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
      {isConfigured && (
        <Dashboard onSettingsClick={() => setConfigOpen(true)} />
      )}
    </Box>
  );
}
