/** Shared project memory (§14) and context management (§15). */

export type MemoryKind =
  | 'specification'
  | 'architecture'
  | 'decision'
  | 'constraint'
  | 'finding'
  | 'risk'
  | 'code_state'
  | 'test_state'
  | 'summary'
  | 'glossary'
  | 'instruction';

export interface MemoryEntry {
  id: string;
  projectId: string;
  kind: MemoryKind;
  /** Short stable handle used in prompts / UI links. */
  key: string;
  title: string;
  body: string;
  /** Superseded entries are kept for audit but excluded from prompts. */
  supersededBy: string | null;
  /** Files this memory refers to (for relevance scoring). */
  relatedFiles: string[];
  /** Task types this memory is relevant to. */
  relatedTaskTypes: string[];
  importance: number; // 0..1
  sourceTaskId: string | null;
  sourceAgentId: string | null;
  /** Trust level: entries written by agents are 'derived' and treated as data. */
  trust: 'user' | 'system' | 'derived';
  createdAt: string;
  updatedAt: string;
}

export interface ProjectSpec {
  goal: string;
  description: string;
  techStack: string[];
  constraints: string[];
  nonFunctional: string[];
  acceptanceCriteria: string[];
  targetUsers: string;
  deliverable: string;
}

export type ProjectStatus =
  | 'draft'
  | 'planning'
  | 'building'
  | 'reviewing'
  | 'blocked'
  | 'completed'
  | 'archived';

export interface Project {
  id: string;
  name: string;
  slug: string;
  description: string;
  spec: ProjectSpec;
  status: ProjectStatus;
  /** Absolute path of the agent sandbox workspace for this project. */
  workspacePath: string;
  /** Git branch agents commit to. */
  branch: string;
  /** Optional upstream source repository (existing code the agents extend). */
  sourceRepo: string | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
  settings: ProjectSettings;
}

export interface ProjectSettings {
  executionMode: import('./task.js').ExecutionMode;
  maxParallelAgents: number;
  autoStart: boolean;
  /** Which agent roles are part of the team. */
  enabledAgents: import('./task.js').AgentId[];
  /** Per-project override of router behaviour. */
  freeOnlyMode: boolean | null;
  /** Per-project hard ceiling on total tokens. */
  maxTotalTokens: number | null;
  /** Git identity used for agent commits. */
  gitAuthorName: string;
  gitAuthorEmail: string;
}

export interface ArchitectureProposal {
  summary: string;
  stack: { layer: string; choice: string; rationale: string }[];
  components: { name: string; responsibility: string; technologies: string[]; dependsOn: string[] }[];
  dataModel: { entity: string; fields: string[]; relations: string[] }[];
  apiSurface: { method: string; path: string; purpose: string }[];
  projectStructure: { path: string; purpose: string }[];
  risks: { risk: string; mitigation: string; severity: string }[];
  openQuestions: string[];
}

export interface ContextBundle {
  /** Assembled prompt, ready to send. */
  text: string;
  includedFiles: { path: string; bytes: number; reason: string }[];
  includedMemory: { id: string; title: string; kind: MemoryKind }[];
  includedMessages: number;
  estimatedTokens: number;
  /** How much we saved by pruning/compressing relative to a naive full-context dump. */
  compression: { naiveTokens: number; actualTokens: number; savedFraction: number };
  notes: string[];
}
