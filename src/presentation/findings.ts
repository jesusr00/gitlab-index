import { stripVTControlCharacters } from 'node:util';
import type { StoredFinding, StoredProject } from '../inventory/store.js';

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: '2-digit', year: 'numeric' });
export function formatDate(value: string | null): string {
  const date = value === null ? null : new Date(value);
  return date === null || Number.isNaN(date.getTime()) ? 'unknown' : dateFormat.format(date);
}
function clean(value: string): string {
  return stripVTControlCharacters(value).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
}
function fit(value: string, width: number): string {
  const chars = [...clean(value)];
  const text = chars.length > width ? `${chars.slice(0, width - 1).join('')}…` : chars.join('');
  return text + ' '.repeat(Math.max(0, width - [...text].length));
}
function state(f: StoredFinding): string {
  return [f.status !== 'resolved' ? f.status : '', f.freshness === 'stale' ? 'stale' : '', f.archived ? 'archived' : '', f.active === false ? 'inactive' : '', f.active === null ? 'activity unknown' : '', !f.member ? 'not a member' : ''].filter(Boolean).join(', ') || '-';
}
function table(rows: string[][], width: number): string[] {
  const headers = ['Tech', 'Version', 'Files', 'Scanned', 'State'];
  const minimum = [4, 7, 5, 10, 5];
  const maximum = [22, 26, 6, 10, 60];
  if (width < 41) return rows.flatMap(row => [`  ${clean(row[0]!)}: ${clean(row[1]!)}`, `  ${row[2]} files | ${row[3]}`, `  State: ${row[4]}`]);
  const sizes = headers.map((header, i) => {
    const longest = rows.reduce((size, row) => Math.max(size, [...clean(row[i]!)].length), header.length);
    return Math.max(minimum[i]!, Math.min(maximum[i]!, longest));
  });
  while (sizes.reduce((sum, size) => sum + size, 8) > width) {
    const candidates = sizes.map((size, i) => ({ i, remaining: size - minimum[i]! })).filter(c => c.remaining > 0).sort((a, b) => b.remaining - a.remaining);
    if (!candidates.length) break;
    const column = candidates[0]!.i;
    sizes[column] = sizes[column]! - 1;
  }
  const line = (cells: string[]) => cells.map((value, i) => fit(value, sizes[i]!)).join('  ').trimEnd();
  return [line(headers), sizes.map(size => '-'.repeat(size)).join('  '), ...rows.map(line)];
}
export function renderFindings(findings: StoredFinding[], width = 120): string {
  if (!findings.length) return 'No results.';
  const projects = new Map<string, StoredFinding[]>();
  for (const f of findings) {
    const key = `${f.host}:${f.projectId}`;
    const group = projects.get(key) ?? [];
    group.push(f); projects.set(key, group);
  }
  const blocks: string[] = [];
  for (const group of projects.values()) {
    const project = group[0]!;
    const entries = new Map<string, { finding: StoredFinding; files: Set<string> }>();
    for (const f of group) {
      const key = JSON.stringify([f.technology, f.version, state(f), formatDate(f.scannedAt)]);
      const entry = entries.get(key) ?? { finding: f, files: new Set<string>() };
      entry.files.add(f.file); entries.set(key, entry);
    }
    const rows = [...entries.values()].map(({ finding: f, files }) => [f.technology, f.version ?? 'unknown', String(files.size), formatDate(f.scannedAt), state(f)]);
    blocks.push([`${project.projectId} ${clean(project.project)}`, clean(project.projectUrl), `Last commit: ${formatDate(project.lastCommitAt)}`, ...table(rows, width), `Details: gitlab-index show ${project.projectId}`].join('\n'));
  }
  return blocks.join('\n\n');
}
export function renderProjectDetails(project: StoredProject, findings: StoredFinding[]): string {
  const header = [
    `${project.id} ${project.path}`, project.url, `Branch: ${project.defaultBranch ?? 'unknown'}`,
    `Status: ${project.status}${project.archived ? ', archived' : ''}${project.active === false ? ', inactive' : ''}${project.active === null ? ', activity unknown' : ''}${!project.member ? ', not a member' : ''}`,
    `Last commit: ${formatDate(project.lastCommitAt)}`, `Scanned: ${formatDate(project.scannedAt)}`, `Checked: ${formatDate(project.checkedAt)}`, `Commit: ${project.sha ?? 'unknown'}`,
    ...(project.error ? [`Error: ${project.error}`] : []),
  ];
  const details = findings.map(f => [
    `${f.technology}: ${f.version ?? 'unknown'} [${state(f)}]`,
    `Source: ${f.source}: ${f.file}`, `Component: ${f.component}`, `Scanned: ${formatDate(f.scannedAt)}`,
    ...(f.reason ? [`Reason: ${f.reason}`] : []),
  ].map(clean).join('\n'));
  return [header.map(clean).join('\n'), ...(details.length ? details : ['No findings.'])].join('\n\n');
}
