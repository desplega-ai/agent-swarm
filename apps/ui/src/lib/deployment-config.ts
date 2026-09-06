interface UiEnvironment {
  VITE_API_URL?: string;
  VITE_API_KEY?: string;
  VITE_USER_ID?: string;
  VITE_DEMO_MODE?: string | boolean;
}

export interface UiDeploymentConfig {
  apiUrl: string | null;
  apiKey: string | null;
  userId: string | null;
  demoMode: boolean;
}

function optionalString(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function enabled(value: string | boolean | undefined): boolean {
  if (typeof value === "boolean") return value;
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

export function parseUiDeploymentConfig(env: UiEnvironment): UiDeploymentConfig {
  const apiUrl = optionalString(env.VITE_API_URL)?.replace(/\/+$/, "") ?? null;
  const apiKey = optionalString(env.VITE_API_KEY);
  const userId = optionalString(env.VITE_USER_ID);

  if (Boolean(apiUrl) !== Boolean(apiKey)) {
    throw new Error("VITE_API_URL and VITE_API_KEY must be set together.");
  }
  if (userId && !apiUrl) {
    throw new Error("VITE_USER_ID requires VITE_API_URL and VITE_API_KEY.");
  }

  return {
    apiUrl,
    apiKey,
    userId,
    demoMode: enabled(env.VITE_DEMO_MODE),
  };
}

export const uiDeploymentConfig = parseUiDeploymentConfig(import.meta.env);
export const isDemoMode = uiDeploymentConfig.demoMode;
