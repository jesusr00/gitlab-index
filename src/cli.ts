#!/usr/bin/env node
import { Command, InvalidArgumentError, Option } from 'commander';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { Inventory, defaultDatabase } from './inventory/store.js';
import { synchronize } from './inventory/sync.js';
import { GitLab, GlabTransport } from './gitlab/client.js';
import { configuredHost, saveHost } from './config/host.js';
import type { Search } from './types.js';
import { parseActivityDate } from './inventory/activity.js';
import { startDiscoveryLoading } from './presentation/loading.js';
import { renderFindings, renderProjectDetails, formatDate } from './presentation/findings.js';

function integer(value: string): number {
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new InvalidArgumentError('Expected a nonnegative integer');
  return Number(value);
}
const packageVersion: string = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const program = new Command().enablePositionalOptions().name('gitlab-index').description('Local technology inventory for your GitLab projects').version(packageVersion)
  .option('--host <hostname>', 'Override GITLAB_INDEX_HOST from the environment or .env')
  .option('--database <path>', 'SQLite inventory location', defaultDatabase());
function output(data: unknown, format: string): void {
  if (!['table', 'json'].includes(format)) throw new Error('Format must be table or json');
  if (format === 'json') console.log(JSON.stringify(data, null, 2));
  else if (Array.isArray(data)) {
    if (!data.length) console.log('No results.');
    else console.table(data);
  } else console.log(data);
}
async function withInventory(action: (inventory: Inventory, host: string) => void | Promise<void>) {
  const opts = program.opts();
  const host = configuredHost(opts.host);
  const inventory = new Inventory(resolve(opts.database));
  try { await action(inventory, host); } finally { inventory.close(); }
}
program.command('config').description('Configure GitLab in the current directory')
  .command('set-host <hostname>').description('Save GITLAB_INDEX_HOST in the current directory\'s .env file')
  .action(host => { console.log(`Saved GITLAB_INDEX_HOST in ${saveHost(host)}`); });
program.command('sync').description('Refresh project membership and scan default branches')
  .option('--force', 'Rescan unchanged projects')
  .option('--concurrency <count>', 'Concurrent projects (1-256)', integer, 4)
  .option('--format <format>', 'table or json', 'table')
  .action(async opts => {
    if (!['table', 'json'].includes(opts.format)) throw new Error('Format must be table or json');
    if (opts.concurrency < 1 || opts.concurrency > 256) throw new Error('Concurrency must be between 1 and 256');
    const controller = new AbortController();
    const interrupt = () => controller.abort(new Error('Synchronization interrupted; run sync again to resume'));
    process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
    try {
      await withInventory(async (inventory, host) => {
        const stopLoading = startDiscoveryLoading();
        try {
          const result = await synchronize(inventory, host, new GitLab(new GlabTransport(host)), {
            force: opts.force, concurrency: opts.concurrency, signal: controller.signal,
            onProgress: message => { stopLoading(); process.stderr.write(message + '\n'); },
          });
          output(opts.format === 'json' ? result : [result], opts.format);
          if (result.failed) process.exitCode = 1;
        } finally { stopLoading(); }
      });
    } finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
  });
program.command('projects').description('List indexed projects and scan status')
  .option('--include-inactive', 'Legacy alias for --include-non-members')
  .option('--include-non-members', 'Include projects no longer in membership')
  .option('--format <format>', 'table or json', 'table')
  .action(async opts => withInventory((inventory, host) => {
    const projects = inventory.projects(host, opts.includeNonMembers || opts.includeInactive);
    output(opts.format === 'json' ? projects : projects.map(p => ({ id: p.id, project: p.path, branch: p.defaultBranch, archived: p.archived, active: p.active, member: p.member, lastCommit: formatDate(p.lastCommitAt), status: p.status, scannedAt: formatDate(p.scannedAt), checkedAt: formatDate(p.checkedAt), error: p.error })), opts.format);
  }));
program.command('search').description('Search declarations in the local inventory (offline)')
  .option('--technology <name>', 'Technology or dependency name (case-insensitive)')
  .option('--project <name>', 'Project name or namespace/path substring (case-insensitive)')
  .option('--major <number>', 'Explicitly selected major version', integer)
  .option('--version <version>', 'Exact declared version (not constraint compatibility)')
  .option('--compatible-with <version>', 'Declarations compatible with a concrete version')
  .addOption(new Option('--activity <state>', 'Project activity based on the last default-branch commit').choices(['active', 'inactive', 'all']).default('active'))
  .option('--active-since <date>', 'Activity cutoff (YYYY-MM-DD; default: six calendar months ago)', value => { parseActivityDate(value); return value; })
  .option('--include-inactive', 'Legacy alias for --include-non-members')
  .option('--include-non-members', 'Include projects no longer in membership')
  .option('--format <format>', 'table or json', 'table')
  .action(async opts => {
    if (!opts.technology && !opts.project?.trim()) throw new Error('Specify --technology or --project');
    if (opts.project !== undefined && !opts.project.trim()) throw new Error('--project must not be empty');
    if ([opts.major !== undefined, !!opts.version, !!opts.compatibleWith].filter(Boolean).length > 1) throw new Error('Use only one of --major, --version, and --compatible-with');
    if (opts.compatibleWith && !/^\d+(?:\.\d+)*(?:(?:[-+.]|[ab]|rc|post|dev)[\w.-]+)?$/.test(opts.compatibleWith)) throw new Error('--compatible-with requires a concrete version');
    await withInventory((inventory, host) => {
      const query: Search = { project: opts.project?.trim(), technology: opts.technology, major: opts.major, version: opts.version, compatibleWith: opts.compatibleWith, includeNonMembers: opts.includeNonMembers || opts.includeInactive, activity: opts.activity, activeSince: opts.activeSince };
      const findings = inventory.search(host, query);
      if (query.activity !== 'all') {
        const missing = inventory.missingCommitDates(host, query.includeNonMembers);
        if (missing) process.stderr.write(`Commit dates are unknown for ${missing} projects; run sync to update them, or use --activity all.\n`);
      }
      if (opts.format === 'json') output(findings, opts.format);
      else if (opts.format === 'table') console.log(renderFindings(findings, process.stdout.columns ?? 120));
      else throw new Error('Format must be table or json');
    });
  });
program.command('show').description('Show a project and all technology evidence, including inactive projects')
  .argument('<project-id>', 'Numeric GitLab project ID', integer)
  .option('--format <format>', 'table or json', 'table')
  .action(async (id, opts) => withInventory((inventory, host) => {
    const project = inventory.projects(host, true).find(p => p.id === id);
    if (!project) throw new Error(`Project ${id} is not indexed; run sync first`);
    const findings = inventory.search(host, { includeNonMembers: true, activity: 'all' }, id);
    if (opts.format === 'json') output({ project, findings }, opts.format);
    else if (opts.format === 'table') console.log(renderProjectDetails(project, findings));
    else throw new Error('Format must be table or json');
  }));
program.parseAsync().catch(error => { process.stderr.write(`Error: ${error instanceof Error ? error.message : 'Command failed'}\n`); process.exitCode = 1; });
