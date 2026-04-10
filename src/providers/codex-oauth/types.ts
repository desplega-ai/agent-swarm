/**
 * TypeScript types for the Codex ChatGPT OAuth flow.
 */

export type CodexOAuthCredentials = {
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

export type CodexOAuthCallbacks = {
  onAuth: (info: { url: string; instructions?: string }) => void;
  onPrompt: (prompt: { message: string; placeholder?: string }) => Promise<string>;
  onProgress?: (message: string) => void;
  onManualCodeInput?: () => Promise<string>;
  originator?: string;
  signal?: AbortSignal;
};

export type CodexAuthJson = {
  auth_mode: "chatgpt";
  OPENAI_API_KEY: null;
  tokens: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    account_id: string;
  };
  last_refresh: string;
};

type TokenResult =
  | { type: "success"; access: string; refresh: string; expires: number }
  | { type: "failed" };

export type { TokenResult };
