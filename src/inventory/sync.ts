import type { Repository, Project } from '../types.js';
import { detect, relevantFile, includes, localIncludePaths } from '../detection/index.js';
import { Collector, fileParseError } from '../detection/shared.js';
import { Inventory } from './store.js';

export interface SyncOptions { force?: boolean; concurrency?: number; signal?: AbortSignal; onProgress?: (message: string) => void }
export interface SyncResult { discovered: number; scanned: number; skipped: number; empty: number; failed: number }
async function scan(repository: Repository, project: Project, sha: string, report: (message: string) => void, signal?: AbortSignal) {
  const progress = (message: string) => report(`scanning ${project.path}: ${message}`);
  progress('listing repository tree');
  let lastReported = 0;
  const paths = await repository.tree(project, sha, signal, entries => {
    if (lastReported === 0 || entries - lastReported >= 1000) {
      progress(`listing repository tree (${entries} entries)`);
      lastReported = entries;
    }
  });
  const selected = paths.filter(relevantFile);
  progress(`listed ${paths.length} entries; found ${selected.length} manifests`);
  const files = new Map<string, string>();
  for (const [index, path] of selected.entries()) {
    signal?.throwIfAborted();
    if (index === 0 || (index + 1) % 25 === 0 || index === selected.length - 1) progress(`reading manifest ${index + 1}/${selected.length}`);
    files.set(path, await repository.file(project, sha, path, signal));
  }
  const ciPaths = new Set<string>();
  const additional = [];
  const ciPath = project.ciConfigPath || '.gitlab-ci.yml';
  const queue: string[] = [];
  if (/^https?:\/\//.test(ciPath) || ciPath.includes('@') || ciPath.includes('$')) {
    const c = new Collector('.gitlab-ci.yml');
    c.add('gitlab-ci', ciPath, 'generic', 'ci', 'External or dynamic project CI configuration was not fetched');
    additional.push(...c.findings);
  } else {
    const path = ciPath.replace(/^\//, '');
    if (paths.includes(path)) queue.push(path);
    else if (project.ciConfigPath) throw new Error(`Configured CI file is missing: ${path}`);
  }
  for (const path of queue) {
    signal?.throwIfAborted();
    if (ciPaths.has(path)) continue;
    ciPaths.add(path);
    if (!files.has(path)) {
      progress(`reading CI configuration ${path}`);
      files.set(path, await repository.file(project, sha, path, signal));
    }
    let entries;
    try { entries = includes(files.get(path)!); } catch (error) { throw fileParseError(path, error); }
    for (const entry of entries) {
      if (!entry.local || entry.local.includes('$')) continue;
      const matches = localIncludePaths(entry.local, paths);
      if (matches.length === 0) throw new Error(`Local CI include is missing: ${entry.local}`);
      for (const included of matches) if (!ciPaths.has(included)) queue.push(included);
    }
  }
  return [...detect(files, ciPaths), ...additional];
}
export async function synchronize(inventory: Inventory, host: string, repository: Repository, options: SyncOptions = {}): Promise<SyncResult> {
  const concurrency = options.concurrency ?? 4;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 256) throw new Error('Concurrency must be an integer between 1 and 256');
  const signal = options.signal;
  const notify = options.onProgress ?? (() => {});
  inventory.acquire();
  try {
    const projects = await repository.projects(signal);
    signal?.throwIfAborted();
    const previous = new Map(inventory.projects(host, true).map(p => [p.id, p]));
    inventory.membership(host, projects);
    const result: SyncResult = { discovered: projects.length, scanned: 0, skipped: 0, empty: 0, failed: 0 };
    const report = (message: string) => {
      const completed = result.scanned + result.skipped + result.empty + result.failed;
      const percentage = result.discovered === 0 ? 100 : Math.floor(completed * 1000 / result.discovered) / 10;
      notify(`[${percentage.toFixed(1)}% ${completed}/${result.discovered}] ${message}`);
    };
    report(projects.length ? 'starting synchronization' : 'no projects to process');
    let index = 0;
    const worker = async () => {
      while (index < projects.length) {
        if (signal?.aborted) return;
        const project = projects[index++]!;
        inventory.scanning(host, project.id);
        try {
          if (project.empty) {
            inventory.snapshot(host, project, null, []); result.empty++; report(`empty ${project.path}`); continue;
          }
          const { sha, committedAt } = await repository.head(project, signal);
          inventory.recordCommit(host, project.id, committedAt);
          const old = previous.get(project.id);
          if (!options.force && old?.sha === sha && old.defaultBranch === project.defaultBranch && old.ciConfigPath === (project.ciConfigPath ?? null) && old.status === 'ready') {
            inventory.unchanged(host, project.id); result.skipped++; report(`unchanged ${project.path}`); continue;
          }
          const findings = await scan(repository, project, sha, report, signal);
          signal?.throwIfAborted();
          inventory.snapshot(host, project, sha, findings); result.scanned++; report(`scanned ${project.path}: ${findings.length} findings`);
        } catch (error) {
          const message = signal?.aborted ? 'Scan interrupted' : error instanceof Error ? error.message : 'Scan failed';
          inventory.failed(host, project.id, message);
          if (!signal?.aborted) result.failed++;
          report(`${signal?.aborted ? 'interrupted' : 'failed'} ${project.path}: ${message}`);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, projects.length) }, worker));
    signal?.throwIfAborted();
    return result;
  } finally { inventory.release(); }
}
