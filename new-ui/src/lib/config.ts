const STORAGE_KEY = "agent-swarm-config";

export interface Config {
  apiUrl: string;
  apiKey: string;
}

const DEFAULT_CONFIG: Config = {
  apiUrl: "http://localhost:3013",
  apiKey: "",
};

export function getConfig(): Config {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(stored) };
    }
  } catch (e) {
    console.error("Failed to load config:", e);
  }
  return DEFAULT_CONFIG;
}

export function saveConfig(config: Config): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
}

export function resetConfig(): void {
  localStorage.removeItem(STORAGE_KEY);
}

export function getDefaultConfig(): Config {
  return { ...DEFAULT_CONFIG };
}
