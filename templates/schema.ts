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
    heartbeatMd: string | null;
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
    heartbeatMd: string;
  };
}

export type AgentAssetKind = "skill" | "schedule" | "workflow";
export type AgentAssetCategory = "skills" | "schedules" | "workflows";

export interface AgentAssetConfig {
  kind: AgentAssetKind;
  name: string;
  displayName: string;
  slug: string;
  title: string;
  description: string;
  version: string;
  category: AgentAssetCategory;
  placeholders: string[];
  runAllSeedersCandidate: boolean;
  /** Marks an asset as an essential, recommended-for-every-swarm building block. */
  must?: boolean;
  tags: string[];
}

export interface AgentAssetResponse {
  config: AgentAssetConfig;
  body: string;
}

export const ASSET_CATEGORIES: AgentAssetCategory[] = ["skills", "schedules", "workflows"];
