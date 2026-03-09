export interface TemplateConfig {
  name: string;
  displayName: string;
  description: string;
  version: string;
  category: "official" | "community";
  icon: string;
  author: string; // "Name <email>" format
  createdAt: string; // ISO date
  lastUpdatedAt: string; // ISO date
  agentDefaults: {
    role: string;
    capabilities: string[];
    maxTasks: number;
    isLead?: boolean;
  };
  files: {
    claudeMd: string | null; // filename or null if not provided
    soulMd: string | null;
    identityMd: string | null;
    toolsMd: string | null;
    setupScript: string | null;
  };
}

export interface TemplateResponse {
  config: TemplateConfig;
  files: {
    claudeMd: string;
    soulMd: string;
    identityMd: string;
    toolsMd: string;
    setupScript: string;
  };
}
