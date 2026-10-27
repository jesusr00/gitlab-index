import { minimatch } from 'minimatch';
import { posix } from 'node:path';
import { Collector, yaml, list, type Data } from './shared.js';

export interface Include { local?: string; external?: string }
function includeEntries(value: unknown): Include[] {
  return list<any>(value).map(entry => {
    if (typeof entry === 'string') return /^https?:\/\//.test(entry) ? { external: entry } : { local: entry };
    if (entry && typeof entry === 'object' && typeof entry.local === 'string') return { local: entry.local };
    return { external: JSON.stringify(entry) };
  });
}
export function includes(text: string): Include[] {
  return includeEntries(yaml(text).include);
}
export function localIncludePaths(pattern: string, paths: string[]): string[] {
  const path = posix.normalize(pattern.replace(/^\//, ''));
  if (path.startsWith('../') || path.includes('$')) return [];
  return paths.filter(p => minimatch(p, path, { dot: true }));
}
export function ci(c: Collector, text: string): void {
  const p = yaml(text);
  for (const entry of includeEntries(p.include)) {
    if (entry.external) c.add('gitlab-ci', entry.external, 'generic', 'ci', 'External CI include was not fetched');
    if (entry.local?.includes('$')) c.add('gitlab-ci', entry.local, 'generic', 'ci', 'Dynamic local CI include was not resolved');
  }
  const image = (entry: unknown) => {
    if (typeof entry === 'string') c.image(entry, 'ci');
    else if (entry && typeof entry === 'object' && typeof (entry as Data).name === 'string') c.image((entry as Data).name, 'ci');
  };
  image(p.image);
  image(p.default?.image);
  for (const [key, job] of Object.entries(p)) {
    if (['default', 'variables', 'include', 'image', 'services', 'workflow'].includes(key) || !job || typeof job !== 'object' || Array.isArray(job)) continue;
    image((job as Data).image);
    for (const service of list((job as Data).services)) image(service);
    if ((job as Data).trigger?.include) c.add('gitlab-ci', JSON.stringify((job as Data).trigger.include), 'generic', 'ci', 'Child pipeline include was not expanded');
  }
  for (const service of list(p.services)) image(service);
  for (const service of list(p.default?.services)) image(service);
}
