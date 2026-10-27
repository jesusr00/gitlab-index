import { execFile } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import type { Project, Repository, CommitHead } from '../types.js';

export interface ApiResponse { status: number; headers: Record<string, string>; body: string }
function decode(response: ApiResponse): any {
  try { return JSON.parse(response.body); } catch { throw new Error('GitLab returned invalid JSON'); }
}
export interface Transport { get(endpoint: string, signal?: AbortSignal): Promise<ApiResponse> }
export class ApiError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
export function validateHost(host: string): string {
  if (!/^[a-z\d](?:[a-z\d.-]*[a-z\d])?(?::\d{1,5})?$/i.test(host)) throw new Error('Host must be a hostname, optionally with a port, without a URL scheme or path');
  return host.toLowerCase();
}
export class GlabTransport implements Transport {
  readonly host: string;
  constructor(host: string) { this.host = validateHost(host); }
  async get(endpoint: string, signal?: AbortSignal): Promise<ApiResponse> {
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      execFile('glab', ['api', '--hostname', this.host, '--method', 'GET', '--include', endpoint],
        { encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, signal, env: { ...process.env, GLAB_CHECK_UPDATE: 'false', NO_COLOR: '1' } },
        (error, stdout) => {
          if (signal?.aborted) { reject(signal.reason); return; }
          const output = stdout.replace(/\r\n/g, '\n');
          const header = output.match(/^HTTP\/[\d.]+\s+(\d+)[^\n]*\n([\s\S]*?)\n\n/);
          if (!header) {
            reject(new Error(error && 'code' in error && error.code === 'ENOENT' ? 'glab is not installed; install it and run glab auth login' : `GitLab request failed on ${this.host}; check glab authentication and access`));
            return;
          }
          if (error && Number(header[1]) < 300) { reject(new Error('GitLab response was incomplete')); return; }
          const headers: Record<string, string> = {};
          for (const line of header[2]!.split('\n')) {
            const colon = line.indexOf(':');
            if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
          }
          resolve({ status: Number(header[1]), headers, body: output.slice(header[0].length) });
        });
    });
  }
}
export class GitLab implements Repository {
  constructor(readonly transport: Transport, private readonly retries = 3, private readonly wait = (ms: number, signal?: AbortSignal) => delay(ms, undefined, { signal })) {}
  private async get(endpoint: string, signal?: AbortSignal): Promise<ApiResponse> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted();
      const response = await this.transport.get(endpoint, signal);
      if (response.status >= 200 && response.status < 300) return response;
      if ((response.status === 429 || response.status >= 500) && attempt < this.retries) {
        const retry = response.headers['retry-after'];
        const reset = response.headers['ratelimit-reset'] ?? response.headers['ratelimit-resettime'];
        const retryMs = retry ? (/^\d+(?:\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()) : NaN;
        const resetMs = reset ? (/^\d+$/.test(reset) ? Number(reset) * 1000 : Date.parse(reset)) - Date.now() : NaN;
        const ms = Math.max(250 * 2 ** attempt, Number.isFinite(retryMs) ? retryMs : Number.isFinite(resetMs) ? resetMs : 0);
        await this.wait(ms, signal);
        continue;
      }
      throw new ApiError(response.status, `GitLab returned HTTP ${response.status}`);
    }
  }
  private async pages<T>(endpoint: string, signal?: AbortSignal, onPage?: (entries: number) => void): Promise<T[]> {
    const items: T[] = [];
    let page = 1;
    for (;;) {
      const response = await this.get(`${endpoint}${endpoint.includes('?') ? '&' : '?'}per_page=100&page=${page}`, signal);
      const body: unknown = decode(response);
      if (!Array.isArray(body)) throw new Error('GitLab returned an invalid collection');
      items.push(...body);
      onPage?.(items.length);
      const next = response.headers['x-next-page'];
      if (next === '' || (next === undefined && body.length < 100)) return items;
      const nextPage = next === undefined ? page + 1 : Number(next);
      if (!Number.isSafeInteger(nextPage) || nextPage <= page) throw new Error('GitLab returned invalid pagination');
      page = nextPage;
    }
  }
  async projects(signal?: AbortSignal): Promise<Project[]> {
    const rows = await this.pages<any>('projects?membership=true&order_by=id&sort=asc', signal);
    const projects = rows.map(p => {
      if (!Number.isSafeInteger(p.id) || !p.path_with_namespace || !p.web_url) throw new Error('GitLab returned invalid project metadata');
      return { id: p.id, path: p.path_with_namespace, url: p.web_url, defaultBranch: p.default_branch ?? null, archived: !!p.archived, empty: p.empty_repo === true, ciConfigPath: p.ci_config_path ?? null };
    });
    return [...new Map(projects.map(p => [p.id, p])).values()];
  }
  async head(project: Project, signal?: AbortSignal): Promise<CommitHead> {
    if (!project.defaultBranch) throw new Error('Project has no default branch');
    const response = await this.get(`projects/${project.id}/repository/branches/${encodeURIComponent(project.defaultBranch)}`, signal);
    const commit = decode(response)?.commit;
    const sha = commit?.id;
    if (typeof sha !== 'string' || !/^[a-f\d]{40,64}$/i.test(sha)) throw new Error('GitLab returned an invalid commit SHA');
    if (typeof commit.committed_date !== 'string' || !Number.isFinite(Date.parse(commit.committed_date))) throw new Error('GitLab returned an invalid commit date');
    return { sha, committedAt: new Date(commit.committed_date).toISOString() };
  }
  async tree(project: Project, sha: string, signal?: AbortSignal, onPage?: (entries: number) => void): Promise<string[]> {
    const entries = await this.pages<{ type: string; mode: string; path: string }>(`projects/${project.id}/repository/tree?recursive=true&ref=${encodeURIComponent(sha)}`, signal, onPage);
    return entries.filter(e => e.type === 'blob' && e.mode !== '120000').map(e => e.path);
  }
  async file(project: Project, sha: string, path: string, signal?: AbortSignal): Promise<string> {
    const response = await this.get(`projects/${project.id}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(sha)}`, signal);
    const body = decode(response);
    if (!body || body.encoding !== 'base64' || typeof body.content !== 'string') throw new Error('GitLab returned invalid file contents');
    if (body.size > 2 * 1024 * 1024 || body.content.length > 3 * 1024 * 1024) throw new Error(`Manifest exceeds the 2 MiB parsing limit: ${path}`);
    return Buffer.from(body.content, 'base64').toString('utf8');
  }
}
