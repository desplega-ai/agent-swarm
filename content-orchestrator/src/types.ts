/** Matches workflow_executions table */
export interface WorkflowExecution {
  id?: number;
  workflowName: string;
  startedAt: string;
  completedAt?: string;
  status: "success" | "failed" | "skipped";
  metadata?: string;
  createdAt?: string;
}

/** Matches content_history table */
export interface ContentRecord {
  id?: number;
  workflowName: string;
  contentType: string;
  contentId: string;
  filePath?: string;
  prUrl?: string;
  status: string;
  topic?: string;
  mainTopic?: string;
  subjects?: string;
  keywords?: string;
  seriesName?: string;
  createdAt?: string;
}

/** Matches image_prompt_history table */
export interface ImagePromptRecord {
  id?: number;
  prompt: string;
  series: string;
  styleCategory: string;
  generationDate: string;
}

/** Matches refresh_history table */
export interface RefreshRecord {
  id?: number;
  contentId: string;
  workflowName: string;
  refreshedAt?: string;
  refreshType: string;
  changesMade?: string;
}

/** Swarm REST API task creation */
export interface CreateTaskRequest {
  task: string;
  agentId?: string;
  taskType?: string;
  tags?: string[];
  priority?: number;
  source?: string;
}

/** Swarm REST API task response */
export interface TaskResponse {
  id: string;
  agentId: string | null;
  task: string;
  status: string;
  output?: string;
  failureReason?: string;
  createdAt?: string;
  lastUpdatedAt?: string;
}

/** Litmus test parsed result */
export interface LitmusResult {
  approved: boolean;
  scores: Record<string, number>;
  totalScore: number;
  maxScore: number;
  rejectionReasons: string[];
  improvementSuggestions: string[];
}

/** Blog metadata from METADATA: line in writer output */
export interface BlogMetadata {
  slug: string;
  image_filename?: string;
}

/** Imgflip meme request from extract_image_prompt output */
export interface MemeRequest {
  template: string;
  text0: string;
  text1: string;
  text2?: string;
  text3?: string;
}

/** Series configuration */
export interface SeriesConfig {
  name: string;
  key: string;
  topicLitmusPrompt: string;
  contentLitmusPrompt: string;
  topicMaxRetries: number;
  contentMaxRetries: number;
}

/** Dedup context injected into research prompts */
export interface DedupContext {
  recentTopics: string[];
  recentMainTopics: string[];
  recentKeywords: string[];
  topicsCount: number;
  toolFrequency?: Record<string, number>;
}

/** Result from a single series execution */
export interface SeriesResult {
  series: string;
  status: "success" | "failed" | "skipped";
  slug?: string;
  filePath?: string;
  imagePath?: string;
  error?: string;
}

/** Overall flow result */
export interface FlowResult {
  status: "success" | "failed" | "skipped";
  seriesResults: SeriesResult[];
  prUrl?: string;
  error?: string;
  startedAt: string;
  completedAt: string;
}

/** Style category definition for meme variety */
export interface StyleCategory {
  name: string;
  description: string;
  keywords: string;
}
