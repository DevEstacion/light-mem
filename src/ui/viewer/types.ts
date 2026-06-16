export interface Observation {
  id: number;
  memory_session_id: string;
  project: string;
  merged_into_project?: string | null;
  platform_source: string;
  type: string;
  title: string | null;
  subtitle: string | null;
  narrative: string | null;
  text: string | null;
  facts: string | null;
  concepts: string | null;
  files_read: string | null;
  files_modified: string | null;
  prompt_number: number | null;
  created_at: string;
  created_at_epoch: number;
}

export interface Summary {
  id: number;
  session_id: string;
  project: string;
  platform_source: string;
  request?: string;
  investigated?: string;
  learned?: string;
  completed?: string;
  next_steps?: string;
  created_at_epoch: number;
}

export interface UserPrompt {
  id: number;
  content_session_id: string;
  project: string;
  platform_source: string;
  prompt_number: number;
  prompt_text: string;
  created_at_epoch: number;
}

export type FeedItem =
  | (Observation & { itemType: 'observation' })
  | (Summary & { itemType: 'summary' })
  | (UserPrompt & { itemType: 'prompt' });

export interface StreamEvent {
  type: 'initial_load' | 'new_observation' | 'new_summary' | 'new_prompt' | 'processing_status';
  observations?: Observation[];
  summaries?: Summary[];
  prompts?: UserPrompt[];
  projects?: string[];
  observation?: Observation;
  summary?: Summary;
  prompt?: UserPrompt;
  isProcessing?: boolean;
  queueDepth?: number;
}

export interface ProjectCatalog {
  projects: string[];
  sources: string[];
  projectsBySource: Record<string, string[]>;
}

export interface Settings {
  LIGHT_MEM_MODEL: string;
  LIGHT_MEM_CONTEXT_OBSERVATIONS: string;
  LIGHT_MEM_WORKER_PORT: string;
  LIGHT_MEM_WORKER_HOST: string;

  LIGHT_MEM_CONTEXT_SHOW_READ_TOKENS?: string;
  LIGHT_MEM_CONTEXT_SHOW_WORK_TOKENS?: string;
  LIGHT_MEM_CONTEXT_SHOW_SAVINGS_AMOUNT?: string;
  LIGHT_MEM_CONTEXT_SHOW_SAVINGS_PERCENT?: string;

  LIGHT_MEM_CONTEXT_FULL_COUNT?: string;
  LIGHT_MEM_CONTEXT_FULL_FIELD?: string;
  LIGHT_MEM_CONTEXT_SESSION_COUNT?: string;

  LIGHT_MEM_CONTEXT_SHOW_LAST_SUMMARY?: string;
  LIGHT_MEM_CONTEXT_SHOW_LAST_MESSAGE?: string;
}

export interface WorkerStats {
  version?: string;
  uptime?: number;
  activeSessions?: number;
  sseClients?: number;
}

export interface DatabaseStats {
  size?: number;
  observations?: number;
  sessions?: number;
  summaries?: number;
  firstObservationAt?: string | null;
}

export interface Stats {
  worker?: WorkerStats;
  database?: DatabaseStats;
}
