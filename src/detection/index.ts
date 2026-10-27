import { posix } from 'node:path';
import type { Finding } from '../types.js';
import { Collector, relevantFile, isDockerfile, isComposeFile, fileParseError } from './shared.js';
import { manifests } from './manifests.js';
import { ci } from './ci.js';
import { compose } from './compose.js';
export { relevantFile, excludedPath } from './shared.js';
export { includes, localIncludePaths } from './ci.js';

export function detect(files: Map<string, string>, ciPaths = new Set(['.gitlab-ci.yml', '.gitlab-ci.yaml'])): Finding[] {
  const findings: Finding[] = [];
  for (const [path, content] of files) {
    if (!relevantFile(path) && !ciPaths.has(path)) continue;
    const c = new Collector(path);
    const name = posix.basename(path);
    try {
      if (ciPaths.has(path)) ci(c, content);
      else if (isComposeFile(name)) compose(c, content);
      else if (isDockerfile(name)) {
        const stages = new Set<string>();
        for (const m of content.replace(/\\\r?\n/g, ' ').matchAll(/^\s*FROM\s+(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/gim)) {
          if (!stages.has(m[1]!.toLowerCase())) c.image(m[1]!, 'docker');
          if (m[2]) stages.add(m[2].toLowerCase());
        }
      } else if (['.nvmrc', '.node-version', '.python-version', '.java-version', '.go-version', '.php-version', 'runtime.txt'].includes(name)) {
        const tech = ({ '.nvmrc': 'node', '.node-version': 'node', '.python-version': 'python', '.java-version': 'java', '.go-version': 'go', '.php-version': 'php', 'runtime.txt': 'python' } as Record<string, string>)[name]!;
        const version = content.split('\n').map(s => s.replace(/#.*/, '').trim()).find(Boolean)?.replace(/^python-/, '');
        c.add(tech, version, 'generic', 'runtime');
      } else if (name === '.tool-versions') {
        for (const line of content.split('\n')) {
          const [tool, ...versions] = line.replace(/#.*/, '').trim().split(/\s+/);
          const tech = ({ nodejs: 'node', node: 'node', python: 'python', java: 'java', golang: 'go', php: 'php', dotnet: 'dotnet', npm: 'npm', pnpm: 'pnpm', yarn: 'yarn' } as Record<string, string>)[tool!];
          if (tech) for (const version of versions) c.add(tech, version, 'generic', 'runtime');
        }
      } else if (name === '.sdkmanrc') {
        const version = content.match(/^java\s*=\s*(.+)$/m)?.[1]?.trim();
        if (version) c.add('java', version, 'generic', 'runtime', undefined, version.match(/^(\d+(?:\.\d+){0,2})-(?:tem|amzn|zulu|open|librca|ms)$/)?.[1]);
      } else manifests(c, content);
    } catch (error) {
      throw fileParseError(path, error);
    }
    findings.push(...c.findings);
  }
  return [...new Map(findings.map(f => [JSON.stringify(f), f])).values()];
}
