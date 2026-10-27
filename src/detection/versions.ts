import semver from 'semver';
import * as pep440 from '@renovatebot/pep440';
import type { Finding, Search, Ecosystem } from '../types.js';

function triplet(value: string): string | null {
  const match = value.trim().match(/^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
  return match ? `${Number(match[1])}.${Number(match[2] ?? 0)}.${Number(match[3] ?? 0)}` : null;
}
function composerRange(value: string): string | null {
  if (/[#@$]|(?:dev-|\s+as\s)|@(?:dev|stable|beta|alpha)/i.test(value)) return null;
  const exact = triplet(value);
  if (exact) return exact;
  return value.replace(/~(\d+)\.(\d+)(?![\d.])/g, (_, a, b) => `>=${a}.${b}.0 <${Number(a) + 1}.0.0`)
    .replace(/(?<!\|)\|(?!\|)/g, '||').replace(/,/g, ' ');
}
function numericRange(value: string): string | null {
  const exact = triplet(value);
  if (exact) return exact;
  const singleton = value.match(/^\[([\d.]+)\]$/);
  if (singleton) return triplet(singleton[1]!);
  const interval = value.match(/^(\[|\()\s*([\d.]*)\s*,\s*([\d.]*)\s*(\]|\))$/);
  if (!interval || (!interval[2] && !interval[3])) return null;
  const lower = interval[2] ? triplet(interval[2]) : null;
  const upper = interval[3] ? triplet(interval[3]) : null;
  if ((interval[2] && !lower) || (interval[3] && !upper)) return null;
  return [lower && `${interval[1] === '[' ? '>=' : '>'}${lower}`, upper && `${interval[4] === ']' ? '<=' : '<'}${upper}`].filter(Boolean).join(' ');
}
function asRange(version: string, ecosystem: Ecosystem): string | null {
  if (ecosystem === 'npm') return semver.validRange(version);
  if (ecosystem === 'composer') {
    const range = composerRange(version);
    return range === null ? null : semver.validRange(range);
  }
  if (ecosystem === 'maven' || ecosystem === 'nuget') {
    const range = numericRange(version);
    if (ecosystem === 'nuget' && triplet(version)) return `>=${triplet(version)}`;
    return range === null ? null : semver.validRange(range);
  }
  return semver.validRange(version);
}
export function supportedVersion(version: string, ecosystem: Ecosystem): boolean {
  if (ecosystem === 'python') {
    return pep440.valid(version) !== null || pep440.validRange(version);
  }
  return asRange(version, ecosystem) !== null;
}
export function matchesVersion(f: Finding, query: Search): boolean {
  if (query.major === undefined && !query.version && !query.compatibleWith) return true;
  if (!f.version || f.status !== 'resolved') return false;
  const declared = f.selector ?? f.version;
  if (query.version) {
    if (f.ecosystem === 'nuget' && triplet(declared)) return false;
    const singleton = f.ecosystem === 'python' ? declared.replace(/^==(?!=)/, '')
      : (f.ecosystem === 'nuget' || f.ecosystem === 'maven') ? declared.replace(/^\[([^,]+)\]$/, '$1') : declared;
    const raw = singleton.replace(/^v/, '');
    return raw === query.version.replace(/^v/, '') && (f.ecosystem === 'python' ? !!pep440.valid(raw) : /^\d+(?:\.\d+)*(?:-[\w.-]+)?$/.test(raw));
  }
  if (query.compatibleWith) {
    if (f.ecosystem === 'python') {
      if (!pep440.valid(query.compatibleWith)) return false;
      const spec = pep440.valid(declared) ? `==${declared}` : declared;
      return pep440.satisfies(query.compatibleWith, spec);
    }
    const candidate = semver.valid(query.compatibleWith);
    if (candidate && f.ecosystem === 'go' && f.technology === 'go' && f.source === 'runtime') {
      const minimum = triplet(declared);
      return minimum !== null && semver.gte(candidate, minimum);
    }
    const range = asRange(declared, f.ecosystem);
    return candidate !== null && range !== null && semver.satisfies(candidate, range);
  }
  const major = query.major!;
  // A major selection may be partial or bounded, but must exclude every other major.
  if (f.ecosystem === 'python') {
    const direct = declared.match(/^(?:==)?(\d+)(?:\.\d+)*(?:\.\*)?$/);
    return !!direct && Number(direct[1]) === major;
  }
  const range = asRange(declared, f.ecosystem);
  if (!range || !semver.minVersion(range)) return false;
  return semver.subset(range, `>=${major}.0.0 <${major + 1}.0.0-0`);
}
