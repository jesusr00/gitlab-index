export type Ecosystem = 'npm' | 'python' | 'maven' | 'nuget' | 'go' | 'composer' | 'generic';
export type Source = 'runtime' | 'manifest' | 'docker' | 'ci';
export interface Finding {
  technology: string;
  version: string | null;
  ecosystem: Ecosystem;
  component: string;
  source: Source;
  file: string;
  status: 'resolved' | 'unknown' | 'unresolved';
  reason: string | null;
  selector?: string;
}
export interface Project {
  id: number;
  path: string;
  url: string;
  defaultBranch: string | null;
  archived: boolean;
  empty: boolean;
  ciConfigPath?: string | null;
}
export interface Search {
  technology?: string;
  major?: number;
  version?: string;
  compatibleWith?: string;
  includeNonMembers?: boolean;
  activity?: 'active' | 'inactive' | 'all';
  activeSince?: string;
}
export interface CommitHead { sha: string; committedAt: string }
export interface Repository {
  projects(signal?: AbortSignal): Promise<Project[]>;
  head(project: Project, signal?: AbortSignal): Promise<CommitHead>;
  tree(project: Project, sha: string, signal?: AbortSignal, onPage?: (entries: number) => void): Promise<string[]>;
  file(project: Project, sha: string, path: string, signal?: AbortSignal): Promise<string>;
}
