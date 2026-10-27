import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseEnv } from 'node:util';
import { validateHost } from '../gitlab/client.js';

function readEnvironmentFile(path: string): string {
  try { return readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}
export function configuredHost(explicit?: string): string {
  const host = explicit ?? process.env.GITLAB_INDEX_HOST ?? parseEnv(readEnvironmentFile(resolve('.env'))).GITLAB_INDEX_HOST;
  if (!host) throw new Error('GitLab host is not configured. Set GITLAB_INDEX_HOST or run gitlab-index config set-host <hostname>');
  return validateHost(host);
}
export function saveHost(value: string): string {
  const host = validateHost(value);
  const path = resolve('.env');
  const contents = readEnvironmentFile(path);
  const withoutHost = contents.replace(/^[ \t]*(?:export[ \t]+)?GITLAB_INDEX_HOST[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\r\n]*)[^\r\n]*(?:\r?\n|$)/gm, '');
  writeFileSync(path, `${withoutHost}${withoutHost && !withoutHost.endsWith('\n') ? '\n' : ''}GITLAB_INDEX_HOST=${host}\n`, { mode: 0o600 });
  return path;
}
