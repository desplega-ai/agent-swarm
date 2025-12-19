import React from "react";
import ReactDOM from "react-dom/client";
import { CssVarsProvider } from "@mui/joy/styles";
import CssBaseline from "@mui/joy/CssBaseline";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import { theme } from "./lib/theme";
import "./index.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchInterval: 5000, // Auto-refresh every 5 seconds
      staleTime: 2000,
    },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <CssVarsProvider
        theme={theme}
        defaultMode="dark"
        modeStorageKey="agent-swarm-mode"
      >
        <CssBaseline />
        <App />
      </CssVarsProvider>
    </QueryClientProvider>
  </React.StrictMode>
);
